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
    this.eventBus.on(EVENTS.TASK_PLAN_FINISH, (e) => this._enqueue(EVENTS.TASK_PLAN_FINISH, e));
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
      case EVENTS.TASK_PLAN_FINISH:
        return this._onPlanFinish(msg);
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
    return new Promise((resolve, reject) => {
      this._pending.set(traceId, { resolve, reject, taskId });
    });
  }

  _resolveTask(traceId, result, error) {
    const p = this._pending.get(traceId);
    if (!p) return;
    this._pending.delete(traceId);
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
      if (p.status === 'idle' || p.status === 'online') idle.push({ name, p });
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

  // ===== 下发子任务（方案 §3.1-4/5，主agent拆解指定执行模型，单模型分配）=====
  async _dispatchSubTask(traceId, sub) {
    // 优先使用拆解时主agent指定的模型（preferred_agent）；不在线/未指定则能力匹配兜底
    let agentNames = [];
    if (sub.preferred_agent && this.profiles.has(sub.preferred_agent)) {
      const p = this.profiles.get(sub.preferred_agent);
      if (p.status === 'idle' || p.status === 'online') agentNames = [sub.preferred_agent];
    }
    if (agentNames.length === 0) {
      agentNames = this._matchAgents(sub.type, this.agentsPerTask, traceId);
    }
    if (agentNames.length === 0) {
      // 无可用 Agent：暂存等待（方案 §4.4.5），通过心跳恢复后重试调度
      console.log(`[Scheduler] 无空闲 Agent，子任务 ${sub.sub_task_id} 等待 Agent 上线`);
      setTimeout(() => this._dispatchReady(traceId), 3000);
      return;
    }

    const subKey = `blackboard:task:${traceId}:sub:${sub.sub_task_id}`;
    const agentIds = agentNames.map(n => AGENT_IDS[n] || n);
    blackboard.hset(subKey, 'agents', JSON.stringify(agentIds));
    blackboard.hset(subKey, 'agent_id', agentIds[0]);
    blackboard.hset(subKey, 'status', SUB_STATUS.RUNNING);
    blackboard.hset(subKey, 'start_time', Date.now());
    blackboard.hset(subKey, 'retry_count', sub.retry_count || 0);

    // 运行中标记（僵尸检测，方案 §2.3.5）
    blackboard.setex(`blackboard:running:${sub.sub_task_id}`, this.timeoutMs, '1');

    for (const n of agentNames) this._setBusy(n, true);

    // 推送：多个 Agent 已接受任务（RUNNING + agent 名）
    this._emitSubUpdate(traceId, sub, SUB_STATUS.RUNNING, agentNames.join('、'));

    // 组装任务输入
    const mainKey = `blackboard:task:${traceId}:main`;
    const userQuery = blackboard.hget(mainKey, 'user_query') || '';
    const externalTaskId = blackboard.hget(mainKey, 'task_id') || traceId;

    // ===== 模型间通信：把直接依赖（上游子任务）的输出注入上下文 =====
    // 下游模型据此看到上游模型的产出（如「基于已搜集的素材」中的素材），
    // 修复依赖子任务收不到上游输出导致执行偏差的问题。
    let deps = sub.deps;
    if (typeof deps === 'string') {
      try { deps = JSON.parse(deps); } catch (e) { deps = []; }
    }
    if (!Array.isArray(deps)) deps = [];
    const DEP_OUTPUT_MAX = 8000; // 单个上游输出最多注入 8000 字符（防上下文爆炸）
    const upstreamParts = [];
    const upstreamSummary = [];
    for (const depId of deps) {
      const depSub = blackboard.hgetall(`blackboard:task:${traceId}:sub:${depId}`);
      if (!depSub || !depSub.sub_task_id) continue;
      const depOutput = depSub.output || '';
      if (!depOutput) continue; // 上游无输出（理论不会发生：DAG 保证 SUCCESS 才就绪）
      const depAgents = this._agentNamesFromSub(depSub).join('、') || '上游模型';
      const truncated = depOutput.length > DEP_OUTPUT_MAX
        ? depOutput.slice(0, DEP_OUTPUT_MAX) + `\n…（输出过长已截断，共 ${depOutput.length} 字符）`
        : depOutput;
      upstreamParts.push(`【上游子任务 ${depId} 的输出（由 ${depAgents} 完成）】\n${truncated}`);
      upstreamSummary.push({ dep_id: depId, agents: depAgents, chars: depOutput.length, preview: depOutput });
    }
    const upstreamContext = upstreamParts.length > 0
      ? `\n\n=== 上游任务输出（供参考，据此完成本子任务） ===\n${upstreamParts.join('\n\n---\n\n')}`
      : '';

    const subTask = {
      task_id: sub.sub_task_id,
      trace_id: traceId,
      external_task_id: externalTaskId, // 关联外部平台 task_id（流式事件/UI 用）
      type: sub.type || '',
      role: sub.role || 'executor',
      context: `任务ID: ${traceId}\n子任务: ${sub.sub_task_id}\n类型: ${sub.type}\n原始请求: ${userQuery}\n参与模型: ${agentNames.join('、')}${upstreamContext}`,
      instruction: sub.input || '',
      input_files: [],
    };

    // 协作日志：记录下发（模型分配 + 注入的上游模型输出 = 模型间消息传递）
    CollabLogger.logDispatch(traceId, sub, agentNames, upstreamSummary);

    // 超时监控
    const timer = setTimeout(() => {
      this._onTimeout(traceId, sub.sub_task_id);
    }, this.timeoutMs);
    this._timers.set(sub.sub_task_id, timer);

    // 并行执行：多个 Agent 各自执行同一子任务（executor 内部负责流式事件）
    const settled = await Promise.allSettled(agentNames.map(n => this._runExecutor(subTask, n, undefined)));

    // 清理超时定时器
    if (this._timers.has(sub.sub_task_id)) {
      clearTimeout(this._timers.get(sub.sub_task_id));
      this._timers.delete(sub.sub_task_id);
    }

    // 分类各 Agent 结果
    const okResults = [];
    const failResults = [];
    const outputsMap = {};
    settled.forEach((r, idx) => {
      const n = agentNames[idx];
      const agentId = AGENT_IDS[n] || n;
      if (r.status === 'fulfilled' && r.value && r.value.content && !(r.value.status === 'failed' || r.value.error)) {
        okResults.push({ agent: n, content: r.value.content, duration: r.value.duration_ms || 0 });
        outputsMap[agentId] = r.value.content;
        CollabLogger.logAgentResult(traceId, sub.sub_task_id, n, true, r.value.content, r.value.duration_ms || 0);
      } else {
        const err = (r.reason && r.reason.message) || (r.value && r.value.error && r.value.error.message) || 'Agent 执行失败';
        failResults.push({ agent: n, error: err });
        outputsMap[agentId] = { error: err };
        CollabLogger.logAgentResult(traceId, sub.sub_task_id, n, false, err, (r.value && r.value.duration_ms) || 0);
      }
    });
    blackboard.hset(subKey, 'outputs', JSON.stringify(outputsMap));

    // 推送子任务执行完成（供 orchestrator 写入对话，展示过程中各模型的输出）
    this.eventBus.emit('collab:subtask:done', {
      task_id: externalTaskId,
      trace_id: traceId,
      sub_task_id: sub.sub_task_id,
      type: sub.type || '',
      status: okResults.length > 0 ? SUB_STATUS.SUCCESS : SUB_STATUS.FAILED,
      agents_outputs: okResults.map(r => ({ agent: r.agent, content: r.content })),
      errors: failResults.map(f => ({ agent: f.agent, error: f.error })),
    });

    if (okResults.length === 0) {
      // 全部失败 → 失败事件（走重试/失败判定）
      const errorMsg = failResults.map(f => `${f.agent}: ${f.error}`).join('; ');
      const failMsg = buildMessage({
        traceId,
        subTaskId: sub.sub_task_id,
        msgType: EVENTS.SUB_TASK_FAIL,
        senderAgent: 'scheduler',
        receiverAgent: 'scheduler',
        output: {},
        errorMsg,
        errorCode: 'ALL_AGENTS_FAILED',
        timeoutMs: this.timeoutMs,
      });
      this.eventBus.emit(EVENTS.SUB_TASK_FAIL, failMsg);
      return;
    }

    // 综合：REVIEW/SUMMARY 合并多个模型意见；执行类取主结果（第一个成功）
    let combined;
    if (sub.type === TASK_TYPES.REVIEW || sub.type === TASK_TYPES.SUMMARY) {
      combined = okResults.map(r => `**${r.agent}**\n${r.content}`).join('\n\n---\n\n');
    } else {
      combined = okResults[0].content;
    }

    const successMsg = buildMessage({
      traceId,
      subTaskId: sub.sub_task_id,
      msgType: EVENTS.SUB_TASK_SUCCESS,
      senderAgent: 'scheduler',
      receiverAgent: 'scheduler',
      taskDeps: [],
      output: { content: combined },
      costMs: okResults.reduce((s, r) => s + r.duration, 0),
      timeoutMs: this.timeoutMs,
    });
    this.eventBus.emit(EVENTS.SUB_TASK_SUCCESS, successMsg);
  }

  /**
   * 执行子任务（注入 executor 的默认实现）
   * 若外部未注入 executor，则尝试用 agentRuntime 直连（由集成方注入）
   */
  async _runExecutor(subTask, agentName, onChunk) {
    if (this.executor && this.executor.run) {
      return this.executor.run(subTask, agentName, onChunk);
    }
    throw new Error('Scheduler executor 未注入');
  }

  // ===== 子任务回调（方案 §3.1-7/8）=====
  async _onSubTaskFinish(msg, ok) {
    const { trace_id: traceId, sub_task_id: subId } = msg.msg_meta;
    const subKey = `blackboard:task:${traceId}:sub:${subId}`;
    const sub = blackboard.hgetall(subKey);
    if (!sub || sub.status !== SUB_STATUS.RUNNING) {
      // 已超时/已处理，忽略迟到回调
      return;
    }

    // 清理超时定时器 + 运行中标记
    const timer = this._timers.get(subId);
    if (timer) { clearTimeout(timer); this._timers.delete(subId); }
    blackboard.del(`blackboard:running:${subId}`);

    // 释放该子任务占用的所有 Agent
    this._releaseAgents(sub);

    const agentLabel = this._agentNamesFromSub(sub).join('、');

    if (ok) {
      const output = (msg.task_result && msg.task_result.output) || {};
      blackboard.hset(subKey, 'status', SUB_STATUS.SUCCESS);
      blackboard.hset(subKey, 'output', output.content || '');
      blackboard.hset(subKey, 'end_time', Date.now());
      // 推送：任务完成（前端打对勾）
      this._emitSubUpdate(traceId, sub, SUB_STATUS.SUCCESS, agentLabel);
    } else {
      const retryCount = (sub.retry_count || 0) + 1;
      const maxRetry = sub.max_retry || 3;
      const errorMsg = (msg.task_result && msg.task_result.error_msg) || 'Unknown error';
      if (retryCount <= maxRetry) {
        // 触发重试（指数退避）
        blackboard.hset(subKey, 'status', SUB_STATUS.RETRYING);
        blackboard.hset(subKey, 'retry_count', retryCount);
        blackboard.hset(subKey, 'error_msg', errorMsg);
        this._emitSubUpdate(traceId, sub, SUB_STATUS.RETRYING, agentLabel);
        const backoff = BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length - 1)] || 1000;
        CollabLogger.logRetry(traceId, subId, retryCount, maxRetry, backoff, errorMsg);
        const retryMsg = buildMessage({
          traceId, subTaskId: subId,
          msgType: EVENTS.SUB_TASK_RETRY,
          senderAgent: 'scheduler',
          taskInput: { retry_count: retryCount },
          errorMsg, errorCode: (msg.task_result && msg.task_result.error_code) || 'RETRY',
          timeoutMs: this.timeoutMs,
        });
        setTimeout(() => {
          this.eventBus.emit(EVENTS.SUB_TASK_RETRY, retryMsg);
        }, backoff);
        return;
      }
      // 重试耗尽 → FAILED
      blackboard.hset(subKey, 'status', SUB_STATUS.FAILED);
      blackboard.hset(subKey, 'error_msg', errorMsg);
      blackboard.hset(subKey, 'end_time', Date.now());
      CollabLogger.logSubFail(traceId, subId, errorMsg);
      this._emitSubUpdate(traceId, sub, SUB_STATUS.FAILED, agentLabel);
    }

    // 触发依赖就绪重新调度
    this._dispatchReady(traceId);
  }

  // ===== 重试事件（方案 §5.1.1）=====
  async _onSubTaskRetry(msg) {
    const traceId = msg.msg_meta.trace_id;
    const subId = msg.msg_meta.sub_task_id;
    const sub = blackboard.hgetall(`blackboard:task:${traceId}:sub:${subId}`);
    if (!sub) return;
    // 重置为 PENDING，重新调度（状态 RETRYING → 重新下发）
    blackboard.hset(`blackboard:task:${traceId}:sub:${subId}`, 'status', SUB_STATUS.PENDING);
    this._emitSubUpdate(traceId, sub, SUB_STATUS.PENDING, null);
    this._dispatchReady(traceId);
  }

  // ===== 超时处理（方案 §5.1.2 僵尸任务）=====
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
    // 清空运行中标记
    const prefix = `blackboard:task:${traceId}:sub:`;
    for (const k of blackboard.keys(prefix)) {
      const sub = blackboard.hgetall(k);
      if (sub && sub.sub_task_id) {
        blackboard.del(`blackboard:running:${sub.sub_task_id}`);
      }
    }
    this._resolveTask(traceId, { trace_id: traceId, status: TASK_STATUS.CANCELLED }, null);
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

module.exports = new Scheduler();
module.exports.Scheduler = Scheduler;
module.exports.defaultDag = defaultDag;
