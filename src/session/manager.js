/**
 * 会话管理器（Session Manager）-- 每个对话（task_id）一个独立 Session
 *
 * 目标：所有对话相互独立、互不影响，各有自己的 thread（消息历史）与 session
 * （运行时状态：活跃 trace、占用模型、状态）。数据层（conversation.md、黑板、
 * 事件路由）已按 task_id 隔离；本模块提供运行时的显式 Session 实体，集中管理
 * 每个对话的运行状态，并支持按会话维度停止/查询。
 *
 * 同一模型一次只服务一个对话：agentRuntime 调用时会把占用关系记到 Session，
 * 若某模型正被其他 Session 占用，则拒绝并发（BUSY），由上层排队重试。
 */
const CollabLogger = require('../utils/collab-logger');

class Session {
  constructor(taskId) {
    this.taskId = taskId;
    this.traces = [];          // 该对话活跃的 trace_id（collab / skill）
    this.busyAgents = new Set(); // 该对话当前占用的模型
    this.status = 'idle';      // idle | running | completed
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
  }

  touch() { this.lastActiveAt = Date.now(); this.status = 'running'; }

  addTrace(traceId) {
    if (!this.traces.includes(traceId)) this.traces.push(traceId);
    this.touch();
  }

  removeTrace(traceId) {
    this.traces = this.traces.filter(t => t !== traceId);
    if (this.traces.length === 0 && this.busyAgents.size === 0) this.status = 'idle';
  }

  occupyAgent(name) { if (name) { this.busyAgents.add(name); this.touch(); } }

  releaseAgent(name) { if (name) this.busyAgents.delete(name); }

  markCompleted() { this.status = 'completed'; }

  toJSON() {
    return {
      task_id: this.taskId,
      status: this.status,
      traces: this.traces,
      busy_agents: Array.from(this.busyAgents),
      created_at: this.createdAt,
      last_active_at: this.lastActiveAt,
    };
  }
}

class SessionManager {
  constructor() {
    this._sessions = new Map(); // taskId -> Session
  }

  /** 取会话（不存在则创建） */
  get(taskId) {
    if (!taskId) return null;
    if (!this._sessions.has(taskId)) {
      this._sessions.set(taskId, new Session(taskId));
    }
    return this._sessions.get(taskId);
  }

  /** 删除会话（对话结束后清理） */
  remove(taskId) {
    this._sessions.delete(taskId);
  }

  /** 标记对话活跃 + 注册 trace */
  registerTrace(taskId, traceId) {
    if (!taskId || !traceId) return;
    this.get(taskId).addTrace(traceId);
  }

  /** 释放 trace */
  releaseTrace(taskId, traceId) {
    const s = this._sessions.get(taskId);
    if (s) s.removeTrace(traceId);
  }

  /** 模型是否正被其他会话占用（当前会话除外） */
  isAgentBusyByOther(taskId, agentName) {
    if (!agentName) return false;
    for (const [tid, s] of this._sessions) {
      if (tid === taskId) continue;
      if (s.busyAgents.has(agentName)) return true;
    }
    return false;
  }

  /** 当前活跃（running 或有 trace/busyAgent）的会话 */
  activeSessions() {
    return Array.from(this._sessions.values()).filter(s =>
      s.status === 'running' || s.traces.length > 0 || s.busyAgents.size > 0);
  }

  /** 停止所有会话（供「结束所有任务」） */
  stopAll() {
    const sessions = this.activeSessions();
    for (const s of sessions) {
      s.busyAgents.clear();
      s.traces = [];
      s.status = 'completed';
      CollabLogger.log('session_stopped', { task_id: s.taskId, session: s.toJSON() });
    }
    return sessions.length;
  }

  /** 会话列表（调试/UI） */
  list() {
    return Array.from(this._sessions.values());
  }
}

const instance = new SessionManager();
module.exports = instance;

