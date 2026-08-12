const { ClaudeAdapter } = require('../adapters/claude');
const { KimiAdapter } = require('../adapters/kimi');
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Agent 运行时管理器
 *
 * 负责 Agent 的生命周期管理：创建、状态监控、心跳检测
 * 一期仅管理克劳德 Agent
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
      // 启用已配置 Agent
      if (agentCfg.name === '克劳德' || agentCfg.name === '吉米') {
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
    // 其他模型二期实现
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
