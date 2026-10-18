const { ClaudeAdapter } = require('../adapters/claude');
const { KimiAdapter } = require('../adapters/kimi');
const { DeepSeekAdapter } = require('../adapters/deepseek');
const { QwenAdapter } = require('../adapters/qwen');
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const toolRegistry = require('../tools/registry');
const sessionManager = require('../session/manager');
const { isFatalError, markAgentFatal, isAgentFatal } = require('../utils/fatal-errors');
const transcript = require('../prompt/transcript');
const { buildSegments, truncate } = require('../prompt/history');
const { historyConfig } = require('../prompt/config');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Agent 运行时管理器
 *
 * 负责 Agent 的生命周期管理：创建、状态监控、心跳检测
 * 二期支持四 Agent 并行运行
 */
class AgentRuntime {
  constructor() {
    this.agents = new Map();
    this.heartbeatInterval = 5000;
    this._timer = null;
    this._callSeq = 0; // 并发调用唯一序号（busy 跟踪用）
  }

  /**
   * 初始化所有已配置的 Agent
   */
  async initialize() {
    const agentsConfig = config.agents;
    const defaultAgent = config.getDefaultAgent();

    console.log(`[AgentRuntime] Initializing agents...`);

    for (const agentCfg of agentsConfig) {
      // 跳过 enabled: false 的 Agent（如吉米暂停使用）
      if (agentCfg.enabled === false) continue;
      // 启用已配置的 Agent（二期：克劳德、吉米、迪普斯克、钱文）
      if (['克劳德', '吉米', '迪普斯克', '钱文'].includes(agentCfg.name)) {
        this._registerAgent(agentCfg);
      }
    }

    if (this.agents.size === 0 && defaultAgent) {
      this._registerAgent(defaultAgent);
    }

    // 启动心跳检测
    await this._startHeartbeat();

    console.log(`[AgentRuntime] ${this.agents.size} agent(s) registered.`);
    return Array.from(this.agents.values());
  }

  _registerAgent(agentCfg) {
    const adapter = this._createAdapter(agentCfg.model_cli);
    const agentState = {
      name: agentCfg.name,
      model_cli: agentCfg.model_cli,
      capabilities: agentCfg.capabilities || [],
      strengths: agentCfg.strengths || [],
      weaknesses: agentCfg.weaknesses || [],
      scenarios: agentCfg.scenarios || [],
      online: false,
      busy: false,
      current_task: null,
      last_heartbeat: null,
      latency_ms: 0,
      adapter,
      // 并发调用跟踪：callId -> taskId。同一模型可被多个对话同时调用，
      // 停止某个对话时只移除该对话的调用（forceReleaseTask），避免误清其他对话的 busy。
      _activeCalls: new Map(),
    };
    this.agents.set(agentCfg.name, agentState);
    return agentState;
  }

  /** 开始一次调用：登记 callId -> taskId，置忙碌 */
  _beginCall(agent, taskId) {
    if (!agent._activeCalls) agent._activeCalls = new Map();
    const callId = `${Date.now().toString(36)}_${++this._callSeq}`;
    agent._activeCalls.set(callId, taskId || null);
    agent.busy = true;
    agent.current_task = taskId || null;
    return callId;
  }

  /** 结束一次调用：移除登记，全部结束才置空闲 */
  _endCall(agent, callId) {
    if (!agent._activeCalls) return;
    agent._activeCalls.delete(callId);
    this._refreshBusy(agent);
  }

  _refreshBusy(agent) {
    const active = agent._activeCalls ? agent._activeCalls.size : 0;
    if (active === 0) {
      agent.busy = false;
      agent.current_task = null;
    } else {
      const tasks = Array.from(agent._activeCalls.values()).filter(Boolean);
      agent.current_task = tasks[tasks.length - 1] || null;
    }
  }

  /**
   * 强制释放某对话占用的调用（用户停止本轮时兜底复位 busy，
   * 不依赖 CLI 进程 promise 自然结束；仅移除该 taskId 的调用）。
   * @returns {number} 释放的调用数
   */
  forceReleaseTask(taskId) {
    if (!taskId) return 0;
    let released = 0;
    for (const agent of this.agents.values()) {
      if (!agent._activeCalls || agent._activeCalls.size === 0) continue;
      let agentReleased = 0;
      for (const [callId, tid] of agent._activeCalls) {
        if (tid === taskId) {
          agent._activeCalls.delete(callId);
          agentReleased++;
        }
      }
      if (agentReleased > 0) {
        released += agentReleased;
        this._refreshBusy(agent);
      }
    }
    return released;
  }

  /** 构造统一「已取消」输出（用户停止本轮） */
  _cancelledOutput(taskId) {
    return {
      task_id: taskId,
      status: 'cancelled',
      content: '',
      output_files: [],
      error: { code: 'CANCELLED', message: '用户已停止本轮任务' },
      tokens_used: 0,
      duration_ms: 0,
    };
  }

  _createAdapter(modelCli) {
    if (modelCli === 'claude') {
      return new ClaudeAdapter();
    }
    if (modelCli === 'kimi') {
      return new KimiAdapter();
    }
    if (modelCli === 'deepseek') {
      return new DeepSeekAdapter();
    }
    if (modelCli === 'qwen') {
      return new QwenAdapter();
    }
    console.warn(`[AgentRuntime] No adapter for model_cli: ${modelCli}, using stub`);
    return null;
  }

  async _startHeartbeat() {
    // 立即执行一次
    await this._runHeartbeat();

    this._timer = setInterval(() => {
      this._runHeartbeat();
    }, this.heartbeatInterval);
  }

  async _runHeartbeat() {
    for (const [name, agent] of this.agents) {
      if (!agent.adapter) {
        agent.online = false;
        continue;
      }
      try {
        const health = await agent.adapter.healthCheck();
        agent.online = health.online;
        agent.latency_ms = health.latency_ms;
        agent.last_heartbeat = new Date().toISOString();
      } catch (e) {
        agent.online = false;
      }
    }
  }

  /**
   * 执行任务 - 通过适配器调用 Agent
   * @param {Function} [onChunk] 流式输出回调：适配器每次捕获到 CLI 增量输出时调用
   */
  async executeTask(task, conversationHistory = [], onChunk) {
    const externalTaskId = task.external_task_id || task.task_id;
    // 用户已停止本轮：不再发起新的模型调用
    if (sessionManager.isCancelled(externalTaskId)) {
      return this._cancelledOutput(task.task_id);
    }
    const agent = this.agents.get('克劳德');
    if (!agent || !agent.adapter) {
      throw new Error('Default agent (克劳德) is not available');
    }
    if (!agent.online) {
      throw new Error('Default agent (克劳德) is offline');
    }

    const callId = this._beginCall(agent, externalTaskId);
    sessionManager.get(task.task_id) && sessionManager.get(task.task_id).occupyAgent('克劳德');

    try {
      const input = {
        task_id: task.task_id,
        external_task_id: task.external_task_id || task.task_id,
        trace_id: task.trace_id || '',
        role: 'executor',
        context: `任务名称: ${task.name}\n任务描述: ${task.description || '无'}\n难度等级: ${task.difficulty || '未知'}\n任务类型: ${task.task_type || 'development'}`,
        instruction: this._buildInstruction(task, conversationHistory),
        input_files: task.input_files || [],
        max_tokens: task.max_tokens || 4096,
        // 请求链路追踪元信息
        agent_name: '克劳德',
        phase: 'initial',
        attempt: task.attempt || 1,
      };

      // 记忆上下文（Session + Auto Memory）注入
      if (task.memory_context && typeof task.memory_context === 'string' && task.memory_context.trim()) {
        input.context = `[系统记忆上下文]\n${task.memory_context.trim()}\n\n${input.context}`;
      }

      const result = await agent.adapter.execute(input, onChunk);
      return result;
    } finally {
      this._endCall(agent, callId);
      sessionManager.get(task.task_id) && sessionManager.get(task.task_id).releaseAgent('克劳德');
    }
  }

  _buildInstruction(task, history) {
    let instruction = task.instruction || '';

    if (history.length > 0) {
      instruction += '\n\n=== 对话历史 ===\n';
      for (const msg of history.slice(-10)) {
        instruction += `\n[${msg.role}]: ${msg.content}`;
      }
    }

    return instruction || `请根据任务描述完成: ${task.description || task.name}`;
  }

  /**
   * 通过指定名称的 Agent 执行任务（二期多Agent协作流程用）
   * @param {Object} task - 任务对象
   * @param {Array} history - 对话历史
   * @param {string} agentName - Agent 名称，如 '克劳德', '吉米', '迪普斯克', '钱文'
   * @param {Function} [onChunk] 流式输出回调：适配器每次捕获到 CLI 增量输出时调用
   */
  async executeTaskWithAgent(task, history, agentName, onChunk) {
    const externalTaskId = task.external_task_id || task.task_id;
    // 用户已停止本轮：不再发起任何新的模型调用（含回退路径）
    if (sessionManager.isCancelled(externalTaskId)) {
      return this._cancelledOutput(task.task_id);
    }
    const agent = this.agents.get(agentName);
    const _fatalFail = () => {
      const msg = `模型 ${agentName} 处于致命错误熔断中（如余额不足/鉴权失败），已跳过调用`;
      console.warn(`[AgentRuntime] ${msg}`);
      return {
        task_id: task.task_id, status: 'failed', content: '',
        output_files: [], error: { code: 'FATAL', message: msg }, tokens_used: 0, duration_ms: 0,
      };
    };
    if (!agent || !agent.adapter) {
      // 回退到克劳德（回退目标也熔断则直接失败，不再烧调用）
      if (isAgentFatal('克劳德')) return _fatalFail();
      console.warn(`[AgentRuntime] Agent "${agentName}" not available, falling back to 克劳德`);
      return this.executeTask(task, history, onChunk);
    }
    if (isAgentFatal(agentName)) return _fatalFail();
    if (!agent.online) {
      if (isAgentFatal('克劳德')) return _fatalFail();
      console.warn(`[AgentRuntime] Agent "${agentName}" is offline, falling back to 克劳德`);
      return this.executeTask(task, history, onChunk);
    }

    // 多对话可同时使用同一模型 CLI：不设 BUSY 闸门，直接并发调用
    // （每次调用都 spawn 新的 CLI 进程）。busy 按「callId -> taskId」跟踪，
    // 保证并发调用互不干扰，且停止某个对话时可精准释放。
    const callId = this._beginCall(agent, externalTaskId);
    sessionManager.get(task.task_id).occupyAgent(agentName);

    // 用户已停止本轮：不再发起任何新的模型调用
    if (sessionManager.isCancelled(externalTaskId)) {
      this._endCall(agent, callId);
      sessionManager.get(task.task_id) && sessionManager.get(task.task_id).releaseAgent(agentName);
      return this._cancelledOutput(task.task_id);
    }

    // ===== function calling 循环（伪 FC：工具 schema 注入 prompt + 解析 [TOOL_CALL] 块）=====
    // skill 内部调用（dimension split/research/draft/review/final）设 disableTools 防递归。
    //
    // Prompt 布局（KV 前缀缓存）：
    //   ZONE A context          —— 工具说明 + 会话级稳定上下文（团队规则/会话目标/冻结记忆）
    //   ZONE B 历史             —— 转录片段原样拼接，只读
    //   ZONE C instruction      —— 本轮内容，只追加，不改写
    // 因此第 N 轮 prompt 是第 N+1 轮 prompt 的严格前缀（工具调用轮同理）。
    const disableTools = !!task.disableTools;
    const MAX_TOOL_ROUNDS = 5;
    const cfg = historyConfig();

    const toolPrompt = (disableTools || !toolRegistry) ? '' : toolRegistry.getToolPrompt();

    // ----- ZONE A：会话级稳定前缀 -----
    const stableParts = [];
    if (toolPrompt) stableParts.push(toolPrompt);
    if (task.stable_context && String(task.stable_context).trim()) {
      stableParts.push(String(task.stable_context).trim());
    } else {
      // 兼容旧调用方（DAG 子任务/规划/内部 skill）：无 stable_context 时按原逻辑拼
      const memoryBlock = task.memory_context ? String(task.memory_context).trim() : '';
      if (memoryBlock) stableParts.push(`## 长期记忆\n${memoryBlock}`);
      stableParts.push(`## 任务背景\n${task.context || this._defaultContext(task)}`);
    }
    const baseContext = stableParts.join('\n\n');

    // ----- ZONE B：历史（只读）-----
    const chatMode = !!task.chat_mode;
    const historySegments = Array.isArray(task.history_segments)
      ? task.history_segments
      : buildSegments(history, cfg);
    const historyBlock = historySegments.join('\n\n');

    // ----- ZONE C：本轮（可追加）-----
    const rawInstruction = task.instruction || this._buildInstruction(task, []);
    let turnSegment = chatMode ? `[用户] ${rawInstruction}` : rawInstruction;
    let currentInstruction = chatMode
      ? `## 对话\n${historyBlock ? historyBlock + '\n\n' : ''}${turnSegment}`
      : turnSegment;

    // 当前轮用户片段先落转录：即使后续调用失败，下一轮仍能拼出严格前缀
    if (chatMode && task.record_transcript && task.task_id) {
      transcript.appendSegments(task.task_id, [turnSegment]);
    }

    const finalize = (result) => {
      if (chatMode && task.record_transcript && task.task_id) {
        const ok = result && result.status !== 'failed' && result.status !== 'cancelled';
        if (ok && result.content && String(result.content).trim()) {
          transcript.appendSegments(task.task_id, [
            `[助手·${agentName}]\n${truncate(String(result.content), cfg.message_max_chars)}`,
          ]);
        }
      }
      return result;
    };

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        // 每轮调用前检查：用户已停止本轮 → 立即返回 cancelled，不再发起新调用
        if (sessionManager.isCancelled(externalTaskId)) {
          return this._cancelledOutput(task.task_id);
        }

        const baseInput = {
          task_id: task.task_id,
          external_task_id: task.external_task_id || task.task_id, // 对话级 task_id，供进程注册/停止匹配
          trace_id: task.trace_id || '', // 事件驱动协作 trace_id（DAG 编排唯一ID）
          role: task.role || 'executor',
          context: baseContext,
          instruction: currentInstruction,
          input_files: task.input_files || [],
          max_tokens: task.max_tokens || 4096,
          // 请求链路追踪元信息：agent 名 + 工具调用轮次（initial / tool_round_N）
          agent_name: agentName,
          phase: round === 0 ? 'initial' : `tool_round_${round}`,
          attempt: task.attempt || 1,
        };

        const result = await agent.adapter.execute(baseInput, onChunk);

        // 用户停止/进程被杀：直接返回 cancelled，不解析工具调用、不再发起下一轮
        if (result && result.status === 'cancelled') return result;

        // 解析工具调用（disableTools 或 skill 内部调用不解析）
        if (disableTools || !toolRegistry) return finalize(result);
        const parsed = toolRegistry.parseToolCallsFromText(result && result.content);
        if (!parsed) return finalize(result); // 无工具调用，正常回复

        const toolCalls = parsed.tool_calls;
        console.log(`[AgentRuntime] 模型调用工具（round ${round}）:`, toolCalls.map(t => t.name).join(','));

        // 常规工具执行
        const toolResults = [];
        for (const tc of toolCalls) {
          const out = await toolRegistry.execute(tc.name, tc.arguments, { agentName, task, runtime: this });
          toolResults.push(`[工具结果: ${tc.name}]\n${out}`);
          // 流式透传工具结果给前端
          if (onChunk) { try { onChunk(`\n\n[工具 ${tc.name} 已执行，结果如下]\n${out.slice(0, 200)}…\n\n`); } catch (e) {} }
        }

        // 下一轮只追加尾部：保留此前全部内容，让新 prompt 以上一轮为前缀
        const prevText = parsed.remaining || '';
        const addition = [
          prevText ? `[助手·${agentName}]\n${prevText}` : '',
          ...toolResults,
          '[系统] 请根据以上工具结果完成最终回复，不要重复调用同一工具。',
        ].filter(Boolean).join('\n\n');

        turnSegment += '\n\n' + addition;
        currentInstruction += '\n\n' + addition;
        if (chatMode && task.record_transcript && task.task_id) {
          transcript.appendSegments(task.task_id, [addition]);
        }
      }
      // 超过最大轮数，返回最后一次结果
      console.warn('[AgentRuntime] 工具调用轮数超过上限，返回当前结果');
      const finalResult = await this._executeOnce(agent, task, baseContext, currentInstruction, onChunk, agentName);
      return finalize(finalResult);
    } finally {
      this._endCall(agent, callId);
      sessionManager.get(task.task_id) && sessionManager.get(task.task_id).releaseAgent(agentName);
    }
  }

  /** 默认任务背景（无 task.context 时兜底） */
  _defaultContext(task) {
    return `任务名称: ${task.name || '未命名'}\n任务描述: ${task.description || '无'}\n难度等级: ${task.difficulty || '未知'}\n任务类型: ${task.task_type || 'development'}`;
  }

  /** 单次执行（无工具循环），用于上限兜底 */
  async _executeOnce(agent, task, context, instruction, onChunk, agentName) {
    const baseInput = {
      task_id: task.task_id,
      external_task_id: task.external_task_id || task.task_id,
      trace_id: task.trace_id || '',
      role: task.role || 'executor',
      context,
      instruction,
      input_files: task.input_files || [],
      max_tokens: task.max_tokens || 4096,
      // 请求链路追踪元信息
      agent_name: agentName,
      phase: 'initial',
      attempt: task.attempt || 1,
    };
    return agent.adapter.execute(baseInput, onChunk);
  }

  /**
   * 获取所有 Agent 的状态快照
   */
  getAgentStates() {
    const states = [];
    for (const [name, agent] of this.agents) {
      states.push({
        name: agent.name,
        model_cli: agent.model_cli,
        online: agent.online,
        busy: agent.busy,
        current_task: agent.current_task,
        last_heartbeat: agent.last_heartbeat,
        latency_ms: agent.latency_ms,
      });
    }
    return states;
  }

  /**
   * 获取指定 Agent 状态
   */
  getAgentState(name) {
    const agent = this.agents.get(name);
    if (!agent) return null;
    return {
      name: agent.name,
      model_cli: agent.model_cli,
      online: agent.online,
      busy: agent.busy,
      current_task: agent.current_task,
      last_heartbeat: agent.last_heartbeat,
      latency_ms: agent.latency_ms,
    };
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.agents.clear();
  }
}

module.exports = new AgentRuntime();
