/**
 * 统一调度器（Scheduler）
 *
 * 按《消息总线+Redis黑板 多Agent协作生产级方案》实现：
 * - 唯一状态决策者：所有状态变更由调度器统一写入黑板，Agent 只读不写
 * - 事件驱动：TASK_CREATE → PLAN → DAG → DEPEND_READY → 能力匹配 → DISPATCH
 *   → 回调 → 状态更新 → 下一轮事件，全程无轮询
 * - DAG 依赖解析：子任务「所有依赖=SUCCESS」才可就绪
 * - Agent 能力画像匹配：task_type + support_task_types + 空闲 + 负载
 * - 重试（指数退避）/ 超时（僵尸检测）/ 幂等 / 心跳
 *
 * 与现有平台集成：单进程内通过注入的 executor 调用 AgentRuntime 执行子任务，
 * 保留事件驱动语义；onChunk 透传给流式管线。
 */

const config = require('../utils/config');
const blackboard = require('../blackboard/blackboard');
const CollabLogger = require('../utils/collab-logger');
const sessionManager = require('../session/manager');
const { isFatalError, markAgentFatal, isAgentFatal, fatalAgents } = require('../utils/fatal-errors');
const {
  EVENTS, TASK_TYPES, SUB_STATUS, TASK_STATUS,
  AGENT_IDS, AGENT_NAMES, genTraceId, genSubTaskId, genMsgId,
  buildMessage, isDuplicate,
} = require('./events');

// ===== 指数退避（方案 §5.1.1）=====
const BACKOFF_MS = [0, 1000, 3000, 5000, 10000];
const DEFAULT_TIMEOUT_MS = 300000;

// ===== capabilities → 任务类型映射（从 agents.yaml 能力派生画像）=====
const CAP_TO_TASK_TYPES = {
  'logic': ['PLAN_TASK', 'REVIEW_TASK'],
  'architecture': ['PLAN_TASK'],
  'complex_code': ['CODE_TASK', 'DEBUG_TASK'],
  'text_refinement': ['REVIEW_TASK', 'SUMMARY_TASK'],
  'long_text': ['SUMMARY_TASK', 'REVIEW_TASK'],
  'information_extraction': ['REVIEW_TASK'],
  'documentation': ['SUMMARY_TASK', 'PLAN_TASK'],
  'algorithm': ['CODE_TASK', 'DEBUG_TASK'],
  'bug_detection': ['DEBUG_TASK', 'REVIEW_TASK'],
  'deep_tech': ['CODE_TASK', 'DEBUG_TASK'],
  'lightweight_dev': ['CODE_TASK'],
  'fast_iteration': ['CODE_TASK', 'DEBUG_TASK'],
  'scenario_fitting': ['CODE_TASK', 'REVIEW_TASK'],
  'chinese_optimization': ['REVIEW_TASK', 'SUMMARY_TASK'],
};

const DEFAULT_LOAD = 0;

/**
 * 生成默认 DAG：规划→执行→评审→汇总（标准协作形态）
 * 供 plannerMode='default' 使用，无需真正调用 LLM 规划
 */
function defaultDag(userQuery, traceId) {
  return [
    {
      seq: 0,
      id: genSubTaskId(traceId, 0),
      type: TASK_TYPES.PLAN,
      instruction: `分析并规划任务，输出执行要点：\n${userQuery}`,
      deps: [],
      role: 'executor',
    },
    {
      seq: 1,
      id: genSubTaskId(traceId, 1),
      type: TASK_TYPES.CODE,
      instruction: `基于规划执行并产出完整结果：\n${userQuery}`,
      deps: [genSubTaskId(traceId, 0)],
      role: 'executor',
    },
    {
      seq: 2,
      id: genSubTaskId(traceId, 2),
      type: TASK_TYPES.REVIEW,
      instruction: `对执行结果进行评审，给出「结论：可行/需修改」及意见补充：\n${userQuery}`,
      deps: [genSubTaskId(traceId, 1)],
      role: 'reviewer',
    },
    {
      seq: 3,
      id: genSubTaskId(traceId, 3),
      type: TASK_TYPES.SUMMARY,
      instruction: `综合以上结果与评审意见，汇总输出最终答案：\n${userQuery}`,
      deps: [genSubTaskId(traceId, 1), genSubTaskId(traceId, 2)],
      role: 'guardian',
    },
  ];
}

class Scheduler {
  constructor() {
    this.eventBus = null;
    this.ready = false;
    this.executor = null;          // async (subTask, onChunk) => { ok, content, error }
    this.plannerMode = 'default';  // 'default' | 'llm'
    this.timeoutMs = DEFAULT_TIMEOUT_MS;
    this.agentsPerTask = 1;        // 每个子任务分配 1 个 Agent（由主agent拆解时指定）
    this.profiles = new Map();     // agentName → 能力画像
    this._pending = new Map();     // traceId → { resolve, reject }
    this._timers = new Map();      // subId → setTimeout
    this._heartbeatTimer = null;
    this._taskSeq = new Map();     // traceId → 子任务序号
    this._rr = 0;                  // 轮转计数器（避免总选同一 Agent）
  }

  /**
   * 初始化：注入依赖、加载 Agent 画像、订阅事件、启动心跳
   * @param {object} deps { eventBus, agentRuntime, executor }
   */
  init({ eventBus, agentRuntime, executor, plannerMode = 'default', timeoutMs, agentsPerTask } = {}) {
    this.eventBus = eventBus;
    this.executor = executor || null;
    this.plannerMode = plannerMode || 'default';
    if (timeoutMs) this.timeoutMs = timeoutMs;
    if (agentsPerTask) this.agentsPerTask = agentsPerTask;

    this._initProfiles(agentRuntime);

    // 订阅事件（方案 §8.1 五大类事件）
    this.eventBus.on(EVENTS.TASK_CREATE, (e) => this._enqueue(EVENTS.TASK_CREATE, e));
    this.eventBus.on(EVENTS.SUB_TASK_SUCCESS, (e) => this._enqueue(EVENTS.SUB_TASK_SUCCESS, e));
    this.eventBus.on(EVENTS.SUB_TASK_FAIL, (e) => this._enqueue(EVENTS.SUB_TASK_FAIL, e));
    this.eventBus.on(EVENTS.SUB_TASK_RETRY, (e) => this._enqueue(EVENTS.SUB_TASK_RETRY, e));
    this.eventBus.on(EVENTS.TASK_CANCEL, (e) => this._enqueue(EVENTS.TASK_CANCEL, e));

    // 心跳：定时维护在线 Agent 画像（方案 §8.2.5）
    this._heartbeatTimer = setInterval(() => {
      this._heartbeat(agentRuntime);
    }, 5000);

    this.ready = true;
    return this;
  }

  stop() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    this.ready = false;
  }

  // ===== Agent 能力画像（方案 §4.4.1）=====
  _initProfiles(agentRuntime) {
    const agents = (config.agents || []).filter(a => AGENT_IDS[a.name]);
    for (const a of agents) {
      const caps = a.capabilities || [];
      const supportTaskTypes = new Set();
      for (const c of caps) {
        (CAP_TO_TASK_TYPES[c] || []).forEach(t => supportTaskTypes.add(t));
      }
      // 所有 Agent 默认都能做 REVIEW/SUMMARY（通用能力）
      supportTaskTypes.add(TASK_TYPES.REVIEW);
      supportTaskTypes.add(TASK_TYPES.SUMMARY);
      // 无能力映射时兜底全类型
      if (supportTaskTypes.size <= 2) {
        Object.values(TASK_TYPES).forEach(t => supportTaskTypes.add(t));
      }
      const state = agentRuntime && agentRuntime.getAgentState ? agentRuntime.getAgentState(a.name) : null;
      this.profiles.set(a.name, {
        agent_instance_id: AGENT_IDS[a.name],
        agent_type: a.name,
        ability_tags: caps,
        support_task_types: Array.from(supportTaskTypes),
        load_score: DEFAULT_LOAD,
        status: state && state.online ? 'idle' : 'offline',
        last_heartbeat: Date.now(),
      });
    }
  }

  _heartbeat(agentRuntime) {
    if (!agentRuntime || !agentRuntime.getAgentStates) return;
    const states = agentRuntime.getAgentStates();
    for (const s of states) {
      const p = this.profiles.get(s.name);
      if (!p) continue;
      const wasBusy = p.status === 'busy';
      p.status = s.online ? (s.busy || wasBusy ? 'busy' : 'idle') : 'offline';
      p.last_heartbeat = Date.now();
      // 同步忙碌状态（AgentRuntime 是实际执行状态源）
      if (!s.busy && p.status === 'busy') p.status = 'idle';
    }
  }

  _setBusy(agentName, busy) {
    const p = this.profiles.get(agentName);
    if (!p) return;
    if (busy) {
      p.status = 'busy';
      p.load_score = Math.min(100, (p.load_score || 0) + 25);
    } else {
      p.status = 'idle';
      p.load_score = Math.max(0, (p.load_score || 0) - 25);
    }
  }

  /**
   * 推送子任务状态更新到前端（右侧任务面板）
   * 事件：collab:subtask:update，data 携带外部 task_id 供前端过滤
   */
  _emitSubUpdate(traceId, sub, status, agentName) {
    if (!this.eventBus) return;
    const mainKey = `blackboard:task:${traceId}:main`;
    const externalTaskId = blackboard.hget(mainKey, 'task_id') || traceId;
    this.eventBus.emit('collab:subtask:update', {
      task_id: externalTaskId,
      trace_id: traceId,
      sub_task_id: (sub && sub.sub_task_id) || (sub && sub.id),
      type: (sub && sub.type) || '',
      status: status,
      agent: agentName || this._agentNamesFromSub(sub).join('、') || '',
      description: (sub && (sub.input || sub.instruction)) || '',
    });
  }

  // ===== 事件队列（避免同步深递归）=====
  _enqueue(type, event) {
    const payload = event && event.data !== undefined ? event.data : event;
    setImmediate(() => {
      this._handle(type, payload).catch((e) => {
        console.error(`[Scheduler] 处理 ${type} 异常:`, e.message);
      });
    });
  }

  async _handle(type, msg) {
    if (!msg || !msg.msg_meta) return;
    const { trace_id: traceId, msg_id: msgId, msg_type } = msg.msg_meta;
    // 幂等校验（方案 §4.3）
    if (isDuplicate(blackboard, msg, this.timeoutMs)) {
      console.log(`[Scheduler] 幂等跳过重复事件 ${msg_type}(${msgId})`);
      return;
    }

    switch (type) {
      case EVENTS.TASK_CREATE:
        return this._onTaskCreate(msg);
      case EVENTS.SUB_TASK_SUCCESS:
        return this._onSubTaskFinish(msg, true);
      case EVENTS.SUB_TASK_FAIL:
        return this._onSubTaskFinish(msg, false);
      case EVENTS.SUB_TASK_RETRY:
        return this._onSubTaskRetry(msg);
      case EVENTS.TASK_CANCEL:
        return this._onCancel(msg);
      default:
        return undefined;
    }
  }

  // ===== 创建顶层任务（方案 §3.1-1）=====
  async createTask(userQuery, opts = {}) {
    const traceId = genTraceId();
    const { taskId, executorAgent } = opts;
    // 顶层任务写黑板（Hash）
    const mainKey = `blackboard:task:${traceId}:main`;
    blackboard.hset(mainKey, 'trace_id', traceId);
    blackboard.hset(mainKey, 'task_id', taskId || null);
    blackboard.hset(mainKey, 'user_query', userQuery);
    blackboard.hset(mainKey, 'overall_status', TASK_STATUS.PENDING);
    blackboard.hset(mainKey, 'create_time', Date.now());
    blackboard.hset(mainKey, 'update_time', Date.now());
    blackboard.hset(mainKey, 'dag_info', '');
    blackboard.hset(mainKey, 'final_result', '');
    blackboard.hset(mainKey, 'fail_reason', '');
    blackboard.hset(mainKey, 'executor_agent', executorAgent || null);

    // 触发 TASK_CREATE 事件（自消费）
    const msg = buildMessage({
      traceId,
      msgType: EVENTS.TASK_CREATE,
      senderAgent: 'scheduler',
      taskInput: { user_query: userQuery, task_id: taskId },
      timeoutMs: this.timeoutMs,
    });
    this.eventBus.emit(EVENTS.TASK_CREATE, msg);

    // 返回 Promise：在任务完结/失败/取消时 resolve
    sessionManager.registerTrace(taskId, traceId);
    return new Promise((resolve, reject) => {
      this._pending.set(traceId, { resolve, reject, taskId });
    });
  }

  _resolveTask(traceId, result, error) {
    const p = this._pending.get(traceId);
    if (!p) return;
    this._pending.delete(traceId);
    if (p.taskId) sessionManager.releaseTrace(p.taskId, traceId);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  }

  // ===== TASK_CREATE → 规划下发（方案 §3.1-2）=====
  async _onTaskCreate(msg) {
    const traceId = msg.msg_meta.trace_id;
    const userQuery = (msg.task_context && msg.task_context.task_input && msg.task_context.task_input.user_query) || '';
    const mainKey = `blackboard:task:${traceId}:main`;
    blackboard.hset(mainKey, 'overall_status', TASK_STATUS.RUNNING);
    blackboard.hset(mainKey, 'update_time', Date.now());

    // 规划：默认 DAG 或调用规划 Agent
    let dag;
    let planSource = 'default';
    if (this.plannerMode === 'llm' && this.executor && this.executor.plan) {
      try {
        dag = await this.executor.plan(userQuery, traceId);
        planSource = 'llm';
      } catch (e) {
        console.error(`[Scheduler] LLM 规划失败，回退默认 DAG:`, e.message);
        dag = defaultDag(userQuery, traceId);
        planSource = 'llm_fallback';
      }
    } else {
      dag = defaultDag(userQuery, traceId);
    }
    if (!Array.isArray(dag) || dag.length === 0) {
      if (planSource === 'llm') planSource = 'llm_fallback';
      dag = defaultDag(userQuery, traceId);
    }
    // 协作日志：记录 DAG 规划（来源 + 子任务 + 依赖）
    CollabLogger.logPlan(traceId, planSource, dag, userQuery);

    // 批量写入子任务（Hash），顶层记录 DAG
    this._taskSeq.set(traceId, dag.length);
    const dagInfo = dag.map(d => ({ id: d.id, type: d.type, deps: d.deps })).reduce((acc, d) => { acc[d.id] = d; return acc; }, {});
    blackboard.hset(mainKey, 'dag_info', JSON.stringify(dagInfo));
    blackboard.hset(mainKey, 'update_time', Date.now());

    for (const d of dag) {
      const subKey = `blackboard:task:${traceId}:sub:${d.id}`;
      blackboard.hset(subKey, 'sub_task_id', d.id);
      blackboard.hset(subKey, 'trace_id', traceId);
      blackboard.hset(subKey, 'agent_id', '');
      blackboard.hset(subKey, 'status', SUB_STATUS.PENDING);
      blackboard.hset(subKey, 'deps', JSON.stringify(d.deps || []));
      blackboard.hset(subKey, 'input', d.instruction || '');
      blackboard.hset(subKey, 'output', '');
      blackboard.hset(subKey, 'error_msg', '');
      blackboard.hset(subKey, 'retry_count', 0);
      blackboard.hset(subKey, 'max_retry', 3);
      blackboard.hset(subKey, 'start_time', 0);
      blackboard.hset(subKey, 'end_time', 0);
      blackboard.hset(subKey, 'timeout_ms', this.timeoutMs);
      blackboard.hset(subKey, 'role', d.role || 'executor');
      blackboard.hset(subKey, 'preferred_agent', d.agent || '');
      // 推送子任务创建（PENDING，前端展示任务列表）
      this._emitSubUpdate(traceId, d, SUB_STATUS.PENDING, null);
    }

    // 推送任务拆解结果（供 orchestrator 写入对话，展示「先拆解」过程）
    const externalTaskId = blackboard.hget(mainKey, 'task_id') || traceId;
    this.eventBus.emit('collab:planned', {
      task_id: externalTaskId,
      trace_id: traceId,
      sub_tasks: dag.map(d => ({ sub_task_id: d.id, type: d.type, description: d.instruction || '' })),
    });

    // 触发依赖就绪事件（开启调度闭环）
    // 延迟一小段：先让前端展示拆解后的任务列表（PENDING/待执行），再开始分配执行
    setTimeout(() => this._dispatchReady(traceId), 200);
    return undefined;
  }

  // ===== 依赖就绪：查找可执行子任务并匹配 Agent 下发 =====
  _dispatchReady(traceId) {
    const mainKey = `blackboard:task:${traceId}:main`;
    const overall = blackboard.hget(mainKey, 'overall_status');
    if (overall === TASK_STATUS.FAILED || overall === TASK_STATUS.CANCELLED) return;

    // 收集所有子任务
    const prefix = `blackboard:task:${traceId}:sub:`;
    const subKeys = blackboard.keys(prefix);
    const subs = subKeys.map(k => blackboard.hgetall(k));
    const pending = subs.filter(s => s.status === SUB_STATUS.PENDING);

    if (pending.length === 0) {
      // 无待执行子任务 → 检查是否全部完成
      const unfinished = subs.filter(s => ![SUB_STATUS.SUCCESS, SUB_STATUS.SKIPPED].includes(s.status));
      if (unfinished.length === 0) {
        this._onAllFinish(traceId, subs);
      }
      return;
    }

    // 筛选依赖全部 SUCCESS 的就绪子任务
    const ready = pending.filter(sub => {
      const deps = (sub.deps && Array.isArray(sub.deps)) ? sub.deps : JSON.parse(sub.deps || '[]');
      if (!deps || deps.length === 0) return true;
      return deps.every(depId => {
        const dep = blackboard.hgetall(`blackboard:task:${traceId}:sub:${depId}`);
        if (!dep || !dep.sub_task_id) return true; // 依赖不存在视为满足（防 DAG 卡死）
        return dep.status === SUB_STATUS.SUCCESS;
      });
    });

    // 逐个下发（能力匹配 → DISPATCH）
    for (const sub of ready) {
      this._dispatchSubTask(traceId, sub);
    }
  }

  // ===== 能力画像匹配（方案 §4.4.3 / §4.4.4，多 Agent 分配 + 轮转）=====
  _matchAgents(taskType, count, traceId) {
    const idle = [];
    for (const [name, p] of this.profiles) {
      if (isAgentFatal(name)) continue; // 熔断中的模型不派发（402/鉴权类致命错误）
      // 多对话可并发使用同一模型：busy 也参与选择（不再因 busy 而排除）
      if (p.status !== 'offline') idle.push({ name, p });
    }
    if (idle.length === 0) return [];

    // 第一优先级：任务类型精准匹配；无则全量兜底（第三优先级）
    const precise = idle.filter(({ p }) => (p.support_task_types || []).includes(taskType));
    const pool = (precise.length > 0 ? precise : idle)
      .sort((a, b) => (a.p.load_score || 0) - (b.p.load_score || 0));

    // 轮转起始偏移：避免多个任务总是分配给同一 Agent
    const start = this._rr % pool.length;
    this._rr++;

    const chosen = [];
    for (let i = 0; i < count && i < pool.length; i++) {
      chosen.push(pool[(start + i) % pool.length].name);
    }
    return chosen;
  }

  /**
   * 从黑板子任务提取 Agent 中文名列表
   */
  _agentNamesFromSub(sub) {
    if (!sub) return [];
    const ids = (sub.agents && Array.isArray(sub.agents)) ? sub.agents : (sub.agent_id ? [sub.agent_id] : []);
    return ids.map(id => AGENT_NAMES[id] || id);
  }

  /**
   * 释放子任务占用的所有 Agent（busy → idle）
   */
  _releaseAgents(sub) {
    for (const n of this._agentNamesFromSub(sub)) {
      this._setBusy(n, false);
    }
  }
  async _onTimeout(traceId, subId) {
    const subKey = `blackboard:task:${traceId}:sub:${subId}`;
    const sub = blackboard.hgetall(subKey);
    if (!sub || sub.status !== SUB_STATUS.RUNNING) return;
    this._timers.delete(subId);
    blackboard.del(`blackboard:running:${subId}`);
    this._releaseAgents(sub);

    const retryCount = (sub.retry_count || 0) + 1;
    const maxRetry = sub.max_retry || 3;
    if (retryCount > 3) {
      // 超时3次直接失败（方案 §5.1.2 兜底）
      blackboard.hset(subKey, 'status', SUB_STATUS.FAILED);
      blackboard.hset(subKey, 'error_msg', '任务超时，重试3次仍失败');
      blackboard.hset(subKey, 'end_time', Date.now());
      CollabLogger.logTimeout(traceId, subId, retryCount, 'fail', '任务超时，重试3次仍失败');
      this._emitSubUpdate(traceId, sub, SUB_STATUS.FAILED, null);
    } else {
      blackboard.hset(subKey, 'status', SUB_STATUS.TIMEOUT);
      blackboard.hset(subKey, 'retry_count', retryCount);
      blackboard.hset(subKey, 'error_msg', '任务执行超时');
      CollabLogger.logTimeout(traceId, subId, retryCount, 'retry', '任务执行超时');
      this._emitSubUpdate(traceId, sub, SUB_STATUS.TIMEOUT, null);
      // 重新调度（换 Agent 重试）
      setTimeout(() => {
        blackboard.hset(subKey, 'status', SUB_STATUS.PENDING);
        this._dispatchReady(traceId);
      }, 1000);
      return;
    }
    this._dispatchReady(traceId);
  }

  // ===== 全部完成（方案 §8.2.4 TASK_ALL_FINISH）=====
  _onAllFinish(traceId, subs) {
    const mainKey = `blackboard:task:${traceId}:main`;
    const overall = blackboard.hget(mainKey, 'overall_status');
    if (overall === TASK_STATUS.SUCCESS || overall === TASK_STATUS.FAILED || overall === TASK_STATUS.CANCELLED) return;

    // 汇总：取 SUMMARY 或最后一个 SUCCESS 子任务输出
    const succeeded = subs.filter(s => s.status === SUB_STATUS.SUCCESS);
    const failed = subs.filter(s => s.status === SUB_STATUS.FAILED);

    let finalResult = '';
    let failReason = '';
    if (failed.length > 0) {
      // 有失败子任务 → 顶层 FAILED（方案 §5.2 全局任务终止）
      failReason = failed.map(f => `${f.sub_task_id}: ${f.error_msg || '失败'}`).join('; ');
      blackboard.hset(mainKey, 'overall_status', TASK_STATUS.FAILED);
      blackboard.hset(mainKey, 'fail_reason', failReason);
      blackboard.hset(mainKey, 'update_time', Date.now());
      CollabLogger.logAllFinish(traceId, TASK_STATUS.FAILED, '', failReason);

      const finalMsg = buildMessage({
        traceId,
        msgType: EVENTS.TASK_FINAL_FAIL,
        senderAgent: 'scheduler',
        output: {},
        errorMsg: failReason,
        errorCode: 'SUB_TASK_FAILED',
        timeoutMs: this.timeoutMs,
      });
      this.eventBus.emit(EVENTS.TASK_FINAL_FAIL, finalMsg);
      this._resolveTask(traceId, null, failReason);
      return;
    }

    // 取 SUMMARY 子任务输出，没有则取最后一个成功子任务
    const summary = succeeded.find(s => s.type === TASK_TYPES.SUMMARY);
    finalResult = summary && summary.output ? summary.output : (succeeded[succeeded.length - 1]?.output || '');

    blackboard.hset(mainKey, 'overall_status', TASK_STATUS.SUCCESS);
    blackboard.hset(mainKey, 'final_result', finalResult);
    blackboard.hset(mainKey, 'update_time', Date.now());
    CollabLogger.logAllFinish(traceId, TASK_STATUS.SUCCESS, finalResult, '');

    const finishMsg = buildMessage({
      traceId,
      msgType: EVENTS.TASK_ALL_FINISH,
      senderAgent: 'scheduler',
      output: { final_result: finalResult },
      timeoutMs: this.timeoutMs,
    });
    this.eventBus.emit(EVENTS.TASK_ALL_FINISH, finishMsg);
    this._resolveTask(traceId, { trace_id: traceId, final_result: finalResult, status: TASK_STATUS.SUCCESS });
  }

  // ===== 取消（方案 §5.2 / §8.2.4）=====
  async _onCancel(msg) {
    const traceId = msg.msg_meta.trace_id;
    const mainKey = `blackboard:task:${traceId}:main`;
    blackboard.hset(mainKey, 'overall_status', TASK_STATUS.CANCELLED);
    blackboard.hset(mainKey, 'update_time', Date.now());
    // 清空运行中标记 + 释放占用的 Agent（busy -> idle）
    const prefix = `blackboard:task:${traceId}:sub:`;
    for (const k of blackboard.keys(prefix)) {
      const sub = blackboard.hgetall(k);
      if (sub && sub.sub_task_id) {
        blackboard.del(`blackboard:running:${sub.sub_task_id}`);
        this._releaseAgents(sub);
        // 清理该子任务的超时定时器
        if (this._timers.has(sub.sub_task_id)) {
          clearTimeout(this._timers.get(sub.sub_task_id));
          this._timers.delete(sub.sub_task_id);
        }
      }
    }
    this._resolveTask(traceId, { trace_id: traceId, status: TASK_STATUS.CANCELLED }, null);
  }

  /**
   * 停止当前所有在跑的任务（顶层 trace），供「结束所有任务」调用
   * @returns {number} 被取消的 trace 数
   */
  stopAll() {
    // 先清掉全部超时定时器，再逐个取消 trace（_onCancel 负责黑板状态/Agent 释放/resolve）
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    const traces = Array.from(this._pending.keys());
    for (const traceId of traces) {
      this.cancelTask(traceId);
    }
    return traces.length;
  }

  /**
   * 取消顶层任务（外部调用）
   */
  cancelTask(traceId) {
    const msg = buildMessage({
      traceId,
      msgType: EVENTS.TASK_CANCEL,
      senderAgent: 'scheduler',
      timeoutMs: this.timeoutMs,
    });
    this.eventBus.emit(EVENTS.TASK_CANCEL, msg);
  }

  /**
   * 获取顶层任务黑板状态（供 UI/调试）
   */
  getTaskState(traceId) {
    const mainKey = `blackboard:task:${traceId}:main`;
    const main = blackboard.hgetall(mainKey);
    if (!main || !main.trace_id) return null;
    const subs = blackboard.keys(`blackboard:task:${traceId}:sub:`)
      .map(k => blackboard.hgetall(k));
    return { ...main, sub_tasks: subs };
  }
}


// 从单独文件加载分发/回调方法（拆分文件，每个<800行）


// 从单独文件加载分发/回调方法（拆分文件，每个<800行）
Object.assign(Scheduler.prototype, require('./dispatch'));

module.exports = new Scheduler();
module.exports.Scheduler = Scheduler;
module.exports.defaultDag = defaultDag;
