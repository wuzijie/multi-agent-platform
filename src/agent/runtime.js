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
  }

  /**
   * 初始化所有已配置的 Agent
   */
  async initialize() {
    const agentsConfig = config.agents;
    const defaultAgent = config.getDefaultAgent();

    console.log(`[AgentRuntime] Initializing agents...`);

    for (const agentCfg of agentsConfig) {
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
    };
    this.agents.set(agentCfg.name, agentState);
    return agentState;
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
    const agent = this.agents.get('克劳德');
    if (!agent || !agent.adapter) {
      throw new Error('Default agent (克劳德) is not available');
    }
    if (!agent.online) {
      throw new Error('Default agent (克劳德) is offline');
    }

    agent._busyCount = (agent._busyCount || 0) + 1;
    agent.busy = true;
    agent.current_task = task.task_id;
    sessionManager.get(task.task_id) && sessionManager.get(task.task_id).occupyAgent('克劳德');

    try {
      const input = {
        task_id: task.task_id,
        role: 'executor',
        context: `任务名称: ${task.name}\n任务描述: ${task.description || '无'}\n难度等级: ${task.difficulty || '未知'}\n任务类型: ${task.task_type || 'development'}`,
        instruction: this._buildInstruction(task, conversationHistory),
        input_files: task.input_files || [],
        max_tokens: task.max_tokens || 4096,
      };

      const result = await agent.adapter.execute(input, onChunk);
      return result;
    } finally {
      agent._busyCount = Math.max(0, (agent._busyCount || 1) - 1);
      if (agent._busyCount === 0) {
        agent.busy = false;
        agent.current_task = null;
      }
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
    // （每次调用都 spawn 新的 CLI 进程）。busy 用计数维护，保证并发时
    // 一个调用结束不会误清其他调用的 busy 状态。
    agent._busyCount = (agent._busyCount || 0) + 1;
    agent.busy = true;
    agent.current_task = task.task_id;
    sessionManager.get(task.task_id).occupyAgent(agentName);

    // ===== function calling 循环（伪 FC：工具 schema 注入 prompt + 解析 [TOOL_CALL] 块）=====
    // skill 内部调用（dimension split/research/draft/review/final）设 disableTools 防递归
    const disableTools = !!task.disableTools;
    const MAX_TOOL_ROUNDS = 5;
    let currentInstruction = task.instruction || this._buildInstruction(task, history);
    let currentContext = task.context || `任务名称: ${task.name}\n任务描述: ${task.description || '无'}\n难度等级: ${task.difficulty || '未知'}\n任务类型: ${task.task_type || 'development'}`;
    const toolPrompt = (disableTools || !toolRegistry) ? '' : toolRegistry.getToolPrompt();

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        // 工具说明直接拼入 context（适配器内置 _buildPrompt 会渲染为任务背景），
        // 不再经过 PromptManager（Prompt 分层管理已回退）
        const effectiveContext = (toolPrompt ? toolPrompt + '\n\n' : '') + currentContext;
        const baseInput = {
          task_id: task.task_id,
          role: task.role || 'executor',
          context: effectiveContext,
          instruction: currentInstruction,
          input_files: task.input_files || [],
          max_tokens: task.max_tokens || 4096,
        };

        const result = await agent.adapter.execute(baseInput, onChunk);

        // 解析工具调用（disableTools 或 skill 内部调用不解析）
        if (disableTools || !toolRegistry) return result;
        const parsed = toolRegistry.parseToolCallsFromText(result && result.content);
        if (!parsed) return result; // 无工具调用，正常回复

        const toolCalls = parsed.tool_calls;
        console.log(`[AgentRuntime] 模型调用工具（round ${round}）:`, toolCalls.map(t => t.name).join(','));
        // 执行工具
        const toolResults = [];
        for (const tc of toolCalls) {
          const out = await toolRegistry.execute(tc.name, tc.arguments, { agentName, task, runtime: this });
          toolResults.push(`[工具结果: ${tc.name}]\n${out}`);
          // 流式透传工具结果给前端
          if (onChunk) { try { onChunk(`\n\n[工具 ${tc.name} 已执行，结果如下]\n${out.slice(0, 200)}…\n\n`); } catch (e) {} }
        }

        // 构建下一轮指令：保留模型已生成文本 + 工具结果，让模型据此继续
        const prevText = parsed.remaining || '';
        currentContext = `${baseInput.context}\n\n=== 已调用工具 ===\n${toolResults.join('\n\n')}`;
        currentInstruction = `你刚才调用了工具并收到了以下结果，请据此完成最终回复（不要再重复调用同一工具）：\n\n${toolResults.join('\n\n')}\n\n${prevText ? `你此前已生成的回复（供参考，可继续完善）：\n${prevText}` : ''}`;
      }
      // 超过最大轮数，返回最后一次结果
      console.warn('[AgentRuntime] 工具调用轮数超过上限，返回当前结果');
      return await this._executeOnce(agent, task, currentContext, currentInstruction, onChunk, agentName);
    } finally {
      // busy 计数递减：并发调用全部结束后才置空闲
      agent._busyCount = Math.max(0, (agent._busyCount || 1) - 1);
      if (agent._busyCount === 0) {
        agent.busy = false;
        agent.current_task = null;
      }
      sessionManager.get(task.task_id) && sessionManager.get(task.task_id).releaseAgent(agentName);
    }
  }

  /** 单次执行（无工具循环），用于上限兜底 */
  async _executeOnce(agent, task, context, instruction, onChunk, agentName) {
    const baseInput = {
      task_id: task.task_id,
      role: task.role || 'executor',
      context,
      instruction,
      input_files: task.input_files || [],
      max_tokens: task.max_tokens || 4096,
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
