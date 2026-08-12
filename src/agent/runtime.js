const { ClaudeAdapter } = require('../adapters/claude');
const { KimiAdapter } = require('../adapters/kimi');
const { DeepSeekAdapter } = require('../adapters/deepseek');
const { QwenAdapter } = require('../adapters/qwen');
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');

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
   */
  async executeTask(task, conversationHistory = []) {
    const agent = this.agents.get('克劳德');
    if (!agent || !agent.adapter) {
      throw new Error('Default agent (克劳德) is not available');
    }
    if (!agent.online) {
      throw new Error('Default agent (克劳德) is offline');
    }

    agent.busy = true;
    agent.current_task = task.task_id;

    try {
      const input = {
        task_id: task.task_id,
        role: 'executor',
        context: `任务名称: ${task.name}\n任务描述: ${task.description || '无'}\n难度等级: ${task.difficulty || '未知'}\n任务类型: ${task.task_type || 'development'}`,
        instruction: this._buildInstruction(task, conversationHistory),
        input_files: task.input_files || [],
        max_tokens: task.max_tokens || 4096,
      };

      const result = await agent.adapter.execute(input);
      return result;
    } finally {
      agent.busy = false;
      agent.current_task = null;
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
   */
  async executeTaskWithAgent(task, history, agentName) {
    const agent = this.agents.get(agentName);
    if (!agent || !agent.adapter) {
      // 回退到克劳德
      console.warn(`[AgentRuntime] Agent "${agentName}" not available, falling back to 克劳德`);
      return this.executeTask(task, history);
    }
    if (!agent.online) {
      console.warn(`[AgentRuntime] Agent "${agentName}" is offline, falling back to 克劳德`);
      return this.executeTask(task, history);
    }

    agent.busy = true;
    agent.current_task = task.task_id;

    try {
      const input = {
        task_id: task.task_id,
        role: task.role || 'executor',
        context: task.context || `任务名称: ${task.name}\n任务描述: ${task.description || '无'}\n难度等级: ${task.difficulty || '未知'}\n任务类型: ${task.task_type || 'development'}`,
        instruction: task.instruction || this._buildInstruction(task, history),
        input_files: task.input_files || [],
        max_tokens: task.max_tokens || 4096,
      };

      const result = await agent.adapter.execute(input);
      return result;
    } finally {
      agent.busy = false;
      agent.current_task = null;
    }
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
