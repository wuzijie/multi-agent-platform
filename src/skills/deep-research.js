/**
 * 深度调研 Skill（DeepResearch）
 *
 * 按《Multi-Agent 深度调研 Skill（标准化技能定义）》实现：
 * - 5 步事件驱动闭环：维度拆解 -> 多模型多角度并行调研 -> 主模型汇总成文
 *   -> 跨模型独立审核 -> 迭代修正终稿，每步完成发布事件触发下一步，无轮询
 * - 不依赖能力画像：仅按「任务角色分工 + 参与状态」调度，所有在线空闲通用模型可参与
 * - 审核强隔离：优先未参与者；全员参与时禁止撰写主模型自审，从调研模型轮换选取
 * - 黑板专属存储：blackboard:skill:deep_research:{trace_id}:*（维度/调研/初稿/审核/终稿）
 *
 * 复用平台基础设施：FileEventBus（消息总线）、文件黑板、agentRuntime（流式执行器）、
 * collab:planned / collab:subtask:update / collab:subtask:done（右侧任务面板与对话展示）、
 * agent:stream:*（前端流式气泡）。子任务状态同时写入 blackboard:task:{trace_id}:sub:*
 * 命名空间，使 GET /tasks/:taskId/collab/state 无需改动即可查询。
 */

const { v4: uuidv4 } = require('uuid');
const eventBus = require('../eventbus/bus');
const blackboard = require('../blackboard/blackboard');
const agentRuntime = require('../agent/runtime');
const scheduler = require('../engine/scheduler');
const config = require('../utils/config');
const CollabLogger = require('../utils/collab-logger');
const {
  SKILL_EVENTS, TASK_STATUS, SUB_STATUS, TASK_TYPES,
  AGENT_IDS, genTraceId, genSubTaskId, buildMessage, isDuplicate,
} = require('../engine/events');

const ALL_AGENTS = Object.keys(AGENT_IDS); // ['克劳德','吉米','迪普斯克','钱文']

// 单次模型调用外层兜底超时（适配器内部已有 240s 超时，此处防悬挂）
const CALL_TIMEOUT_MS = 400000;

// ===== 触发准入（定义 §二：满足任一自动触发；简单问答不触发）=====
const TRIGGER_PATTERNS = [
  /深度调研|调研报告|研究报告|行业分析|竞品分析|方案调研|深度总结|复盘分析/,
  /多角度|多维度|多个角度|多个维度|多视角/,
  /利弊|优劣|优劣势|正反方|正反面/,
];

/**
 * 维度拆解失败时的兜底双维度（定义 §四 Step2：A 正向、B 反向）
 */
function defaultDimensions(userQuery) {
  return [
    {
      name: '正向视角：优势、现状与机遇',
      goal: `围绕「${userQuery}」梳理现状、已有优势、成熟做法与发展机遇，给出事实与论据`,
      perspective: '正向/优势/现状',
      format: '要点 + 论据，800-1500字',
    },
    {
      name: '反向视角：风险、短板与挑战',
      goal: `围绕「${userQuery}」识别风险、短板、反面案例与潜在挑战，给出事实与论据`,
      perspective: '反向/风险/短板',
      format: '要点 + 论据，800-1500字',
    },
  ];
}

class DeepResearchSkill {
  constructor() {
    this.ready = false;
    this.eventBus = eventBus;
    this._pending = new Map(); // traceId -> { resolve, reject }
    this._states = new Map();  // traceId -> 运行态（taskId/主模型/维度/参与者/子任务序列…）
    this._rr = 0;              // 审核轮换计数
  }

  /** 初始化：订阅 6 个 Skill 专属事件（幂等，仅一次） */
  init() {
    if (this.ready) return this;
    for (const evt of Object.values(SKILL_EVENTS)) {
      this.eventBus.on(evt, (e) => {
        const payload = (e && e.data !== undefined) ? e.data : e;
        setImmediate(() => {
          this._handle(evt, payload).catch((err) => {
            console.error(`[DeepResearch] 处理 ${evt} 异常:`, err.message);
          });
        });
      });
    }
    this.ready = true;
    return this;
  }

  // ===== 触发准入：用户请求是否命中调研类需求 =====
  detect(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (t.length < 8) return false; // 过短视为简单问答，禁止触发
    return TRIGGER_PATTERNS.some((re) => re.test(t));
  }

  /**
   * 启动深度调研全流程（对外入口）
   * @param {object} opts { taskId, userQuery, mainAgent }
   * @returns {Promise<{trace_id, final_result, status}>}
   */
  run({ taskId, userQuery, mainAgent = '克劳德' }) {
    this.init();
    const traceId = genTraceId('deep_research');
    const state = {
      traceId,
      taskId,
      externalTaskId: taskId || traceId,
      userQuery: userQuery || '',
      mainAgent,
      participants: new Set(),   // 本轮参与过调研/撰写的模型（审核隔离依据）
      dimensions: [],
      assignments: [],           // [{ seq, subId, dim, agent }]
      researcherNames: [],
      seq: 0,
      startTime: Date.now(),
    };
    this._states.set(traceId, state);

    // 顶层任务黑板（与调度器同一命名空间，供 collab/state 查询与前端面板）
    const mainKey = `blackboard:task:${traceId}:main`;
    blackboard.hset(mainKey, 'trace_id', traceId);
    blackboard.hset(mainKey, 'task_id', taskId || null);
    blackboard.hset(mainKey, 'skill', 'deep_research');
    blackboard.hset(mainKey, 'user_query', userQuery || '');
    blackboard.hset(mainKey, 'executor_agent', mainAgent);
    blackboard.hset(mainKey, 'overall_status', TASK_STATUS.RUNNING);
    blackboard.hset(mainKey, 'create_time', Date.now());
    blackboard.hset(mainKey, 'update_time', Date.now());
    blackboard.hset(mainKey, 'dag_info', '');
    blackboard.hset(mainKey, 'final_result', '');
    blackboard.hset(mainKey, 'fail_reason', '');

    CollabLogger.log('skill_dr_start', { trace_id: traceId, task_id: taskId, user_query: userQuery, main_agent: mainAgent });

    // 发布启动事件（Step 1 触发）
    this.eventBus.emit(SKILL_EVENTS.DEEP_RESEARCH_START, buildMessage({
      traceId,
      msgType: SKILL_EVENTS.DEEP_RESEARCH_START,
      senderAgent: 'skill:deep_research',
      taskInput: { user_query: userQuery, task_id: taskId, main_agent: mainAgent },
    }));

    return new Promise((resolve, reject) => {
      this._pending.set(traceId, { resolve, reject });
    });
  }

  // ===== 事件分发（幂等 + 与调度器一致的消费语义）=====
  async _handle(type, msg) {
    if (!msg || !msg.msg_meta) return;
    const traceId = msg.msg_meta.trace_id;
    if (isDuplicate(blackboard, msg, CALL_TIMEOUT_MS)) return;

    const state = this._states.get(traceId);
    if (!state) return; // 未知/已完结 trace

    switch (type) {
      case SKILL_EVENTS.DEEP_RESEARCH_START:
        return this._step1Dimensions(state);
      case SKILL_EVENTS.RESEARCH_DIMENSION_READY:
        return this._step2ParallelResearch(state);
      case SKILL_EVENTS.MULTI_RESEARCH_ALL_FINISH:
        return this._step3Draft(state);
      case SKILL_EVENTS.RESEARCH_DRAFT_FINISH:
        return this._step4Review(state);
      case SKILL_EVENTS.REVIEW_RESULT_FINISH:
        return this._step5Final(state);
      default:
        return undefined;
    }
  }

  /** 兜底失败：写黑板、发布完结事件、reject */
  _fail(state, reason) {
    const mainKey = `blackboard:task:${state.traceId}:main`;
    blackboard.hset(mainKey, 'overall_status', TASK_STATUS.FAILED);
    blackboard.hset(mainKey, 'fail_reason', reason);
    blackboard.hset(mainKey, 'update_time', Date.now());
    CollabLogger.log('skill_dr_fail', { trace_id: state.traceId, reason });
    this._finish(state, TASK_STATUS.FAILED, '', reason);
  }

  _finish(state, status, finalResult, failReason) {
    this.eventBus.emit(SKILL_EVENTS.DEEP_RESEARCH_COMPLETE, buildMessage({
      traceId: state.traceId,
      msgType: SKILL_EVENTS.DEEP_RESEARCH_COMPLETE,
      senderAgent: 'skill:deep_research',
      output: { final_result: finalResult, status },
      errorMsg: failReason || '',
    }));
    const p = this._pending.get(state.traceId);
    this._pending.delete(state.traceId);
    this._states.delete(state.traceId);
    if (p) {
      if (status === TASK_STATUS.SUCCESS) p.resolve({ trace_id: state.traceId, final_result: finalResult, status });
      else p.reject(new Error(failReason || '深度调研失败'));
    }
  }

  // ============================================================
  // Step 1：确定思考方向（维度拆解）—— 主模型执行
  // ============================================================
  async _step1Dimensions(state) {
    const { traceId } = state;
    // 主模型不在线时换任一在线模型收口
    if (!this._onlineAgents().includes(state.mainAgent)) {
      const alt = this._onlineAgents()[0];
      if (!alt) return this._fail(state, '无在线模型，深度调研无法启动');
      CollabLogger.log('skill_dr_main_offline', { trace_id: traceId, from: state.mainAgent, to: alt });
      state.mainAgent = alt;
    }

    const subId = this._phaseSub(state, TASK_TYPES.PLAN, '拆解调研维度（多角度思考方向）', state.mainAgent);
    this._phaseStart(state, subId, state.mainAgent);

    const prompt = [
      '你是多智能体平台的深度调研规划模型，负责为一次多模型多角度调研拆解思考维度。',
      '',
      '要求：',
      '1. 针对用户需求拆解出「独立、不重叠、互补」的调研维度（至少2个，复杂任务3-5个）',
      '2. 维度之间视角必须差异化（如：正向优势/反向风险/行业视角/用户视角/落地视角等）',
      '3. 每个维度定义：调研目标、分析视角、输出格式、论证要求',
      '',
      '输出纯 JSON 数组，不要任何其他文字或 markdown 围栏，格式：',
      '[{"name":"维度名称","goal":"调研目标","perspective":"分析视角","format":"输出格式与论证要求"}]',
      '',
      '用户需求：' + state.userQuery,
    ].join('\n');

    let dimensions = null;
    try {
      const content = await this._callAgent(state.mainAgent, prompt, state, '规划：维度拆解');
      dimensions = this._parseDimensions(content);
    } catch (e) {
      CollabLogger.log('skill_dr_dimension_call_fail', { trace_id: traceId, error: e.message });
    }
    if (!dimensions || dimensions.length < 2) {
      dimensions = defaultDimensions(state.userQuery); // 兜底：正向 + 反向
      CollabLogger.log('skill_dr_dimension_fallback', { trace_id: traceId, count: dimensions.length });
    }
    // 复杂度上限：最多5个维度
    if (dimensions.length > 5) dimensions = dimensions.slice(0, 5);

    state.dimensions = dimensions;

    // 落库：维度清单（黑板专属 Key，定义 §七）
    blackboard.set(`blackboard:skill:deep_research:${traceId}:dimensions`, dimensions);
    this._phaseDone(state, subId, '维度拆解完成', dimensions.map((d, i) => `${i + 1}. ${d.name}（${d.perspective || ''}）`).join('\n'));

    CollabLogger.log('skill_dr_dimensions_ready', {
      trace_id: traceId,
      main_agent: state.mainAgent,
      dimensions: dimensions.map((d) => d.name),
    });

    // 预创建后续阶段子任务（调研N个 + 汇总 + 审核 + 终稿），一次性下发完整任务列表
    const planned = [];
    state.assignments = dimensions.map((dim, i) => {
      const sId = this._phaseSub(state, 'RESEARCH_TASK', `调研：${dim.name}`, null);
      planned.push({ sub_task_id: sId, type: 'RESEARCH_TASK', description: `调研：${dim.name}` });
      return { seq: i, subId: sId, dim, agent: null, retry: 0 };
    });
    state.subSummary = this._phaseSub(state, TASK_TYPES.SUMMARY, '汇总整合，撰写初稿', null);
    state.subReview = this._phaseSub(state, TASK_TYPES.REVIEW, '跨模型独立审核', null);
    state.subFinal = this._phaseSub(state, 'FINAL_TASK', '按审核意见迭代修正，产出终稿', null);
    planned.push({ sub_task_id: state.subSummary, type: TASK_TYPES.SUMMARY, description: '汇总整合，撰写初稿' });
    planned.push({ sub_task_id: state.subReview, type: TASK_TYPES.REVIEW, description: '跨模型独立审核' });
    planned.push({ sub_task_id: state.subFinal, type: 'FINAL_TASK', description: '按审核意见迭代修正，产出终稿' });

    // 推送完整任务列表（前端右侧面板一次性展示，复用协作面板管线）
    this.eventBus.emit('collab:planned', {
      task_id: state.externalTaskId,
      trace_id: traceId,
      main_agent: state.mainAgent,
      skill: 'deep_research',
      sub_tasks: planned,
    });

    // 发布维度就绪事件（Step 2 触发）
    this.eventBus.emit(SKILL_EVENTS.RESEARCH_DIMENSION_READY, buildMessage({
      traceId,
      msgType: SKILL_EVENTS.RESEARCH_DIMENSION_READY,
      senderAgent: 'skill:deep_research',
      taskInput: { dimensions },
    }));
  }

  // ============================================================
  // Step 2：多模型多角度并行调研 —— 至少2个不同调研模型
  // ============================================================
  async _step2ParallelResearch(state) {
    const { traceId } = state;
    // 调研模型池：在线 & 非主模型（不足时允许主模型补位，保证双模型差异化）
    let pool = this._shuffle(this._onlineAgents().filter((n) => n !== state.mainAgent));
    if (pool.length < 2) {
      const mainOnline = this._onlineAgents().includes(state.mainAgent);
      if (mainOnline && this._onlineAgents().length >= 2) {
        pool = pool.concat([state.mainAgent]); // 极端情况兜底：主模型兼任一个调研维度
        CollabLogger.log('skill_dr_research_pool_main_fallback', { trace_id: traceId, pool });
      } else {
        // 无空闲模型：排队等待节点释放（定义 §六.4），3s 后重试一次
        if (!state._poolWaitRetry) {
          state._poolWaitRetry = true;
          CollabLogger.log('skill_dr_wait_agents', { trace_id: traceId, retry_in_ms: 3000 });
          setTimeout(() => {
            this.eventBus.emit(SKILL_EVENTS.RESEARCH_DIMENSION_READY, buildMessage({
              traceId,
              msgType: SKILL_EVENTS.RESEARCH_DIMENSION_READY,
              senderAgent: 'skill:deep_research',
              taskInput: { dimensions: state.dimensions, retry: true },
            }));
          }, 3000);
          return;
        }
        return this._fail(state, '可用调研模型不足（需至少2个在线模型）');
      }
    }

    // 随机分配：不同维度尽量分给不同模型，强制视角差异化（定义 §四 Step2）
    state.researcherNames = [...new Set(pool)];
    state.assignments.forEach((a, i) => { a.agent = pool[i % pool.length]; });
    for (const n of state.researcherNames) state.participants.add(n);
    state.participants.add(state.mainAgent); // 主模型参与撰写（审核隔离依据）

    CollabLogger.log('skill_dr_research_dispatch', {
      trace_id: traceId,
      assignments: state.assignments.map((a) => ({ dim: a.dim.name, agent: a.agent })),
    });

    // 并行独立调研（互不干扰，各自落独立黑板快照避免覆盖）
    const settled = await Promise.allSettled(state.assignments.map((a) => this._researchOne(state, a)));
    const okCount = settled.filter((r) => r.status === 'fulfilled').length;

    if (okCount === 0) {
      const err = settled.map((r) => (r.reason && r.reason.message) || '失败').join('; ');
      return this._fail(state, `全部维度调研失败：${err}`);
    }
    if (okCount < state.assignments.length) {
      CollabLogger.log('skill_dr_research_partial', {
        trace_id: traceId,
        ok: okCount,
        total: state.assignments.length,
      });
    }

    // 发布调研全部完成事件（Step 3 触发）
    this.eventBus.emit(SKILL_EVENTS.MULTI_RESEARCH_ALL_FINISH, buildMessage({
      traceId,
      msgType: SKILL_EVENTS.MULTI_RESEARCH_ALL_FINISH,
      senderAgent: 'skill:deep_research',
      taskInput: { ok_count: okCount, total: state.assignments.length },
    }));
  }

  /** 执行单个维度的调研（失败自动换模型重试一次） */
  async _researchOne(state, a) {
    const { traceId } = state;
    const { dim, subId } = a;
    let agent = a.agent;
    let attempt = 0;
    // 最多尝试2次：第一次失败换另一个调研模型重试
    while (attempt < 2) {
      this._phaseStart(state, subId, agent);
      const prompt = [
        `你是深度调研中的独立调研模型，负责以下调研维度（只做本维度，不要涉及其他视角）：`,
        `维度名称：${dim.name}`,
        `调研目标：${dim.goal || ''}`,
        `分析视角：${dim.perspective || ''}`,
        `输出/论证要求：${dim.format || '要点 + 论据'}`,
        '',
        '要求独立调研、给出观点与依据，输出本维度的调研结论（论据、信息、观点），不要写其他维度的内容。',
        '',
        '用户需求：' + state.userQuery,
      ].join('\n');
      try {
        const output = await this._callAgent(agent, prompt, state, `调研：${dim.name}`);
        // 落库：独立快照（维度名做 field，互不覆盖，定义 §四 Step2）
        blackboard.hset(`blackboard:skill:deep_research:${traceId}:sub_research`, dim.name, {
          agent, dimension: dim.name, perspective: dim.perspective || '',
          output, duration: Date.now(), retry: attempt,
        });
        this._phaseDone(state, subId, agent, `调研完成（${output.length} 字）`);
        this._emitSubDone(state, 'RESEARCH_TASK', subId, [{ agent, content: output }]);
        return { dim: dim.name, agent, output };
      } catch (e) {
        CollabLogger.log('skill_dr_research_fail', { trace_id: traceId, dim: dim.name, agent, attempt, error: e.message });
        attempt += 1;
        // 换一个不同的调研模型重试
        const others = state.researcherNames.filter((n) => n !== agent);
        if (others.length > 0) agent = others[attempt % others.length];
        a.agent = agent;
      }
    }
    this._phaseFail(state, subId, `维度「${dim.name}」调研失败（已重试）`);
    throw new Error(`维度「${dim.name}」调研失败`);
  }

  // ============================================================
  // Step 3：主模型汇总、整合、撰写成文
  // ============================================================
  async _step3Draft(state) {
    const { traceId } = state;
    this._phaseStart(state, state.subSummary, state.mainAgent);

    const researches = blackboard.hgetall(`blackboard:skill:deep_research:${traceId}:sub_research`) || {};
    const sections = Object.entries(researches).map(([dimName, r]) => (
      typeof r === 'string'
        ? `【${dimName}】\n${r}`
        : `【${dimName}】（由 ${r.agent} 调研）\n${r.output || ''}`
    )).join('\n\n---\n\n');

    const prompt = [
      '你是深度调研的主汇总模型，负责把多个模型的多角度独立调研结果整合为一篇完整报告。',
      '',
      '要求：',
      '1. 读取全部调研素材：去重、互补、纠偏、整合冲突观点',
      '2. 按调研报告标准结构撰写：标题、背景/概述、多维度分析、综合结论与建议',
      '3. 逻辑串联、观点论证、内容落地，输出完整初稿（不要写审核意见，终稿另有机会修订）',
      '',
      `用户需求：${state.userQuery}`,
      '',
      '=== 多模型多角度调研素材 ===',
      sections,
    ].join('\n');

    let draft;
    try {
      draft = await this._callAgent(state.mainAgent, prompt, state, '汇总：撰写初稿');
    } catch (e) {
      return this._fail(state, `初稿撰写失败：${e.message}`);
    }

    // 落库：初稿待审核快照
    blackboard.set(`blackboard:skill:deep_research:${traceId}:draft`, {
      agent: state.mainAgent, content: draft, time: Date.now(),
    });
    this._phaseDone(state, state.subSummary, state.mainAgent, `初稿完成（${draft.length} 字）`);
    this._emitSubDone(state, TASK_TYPES.SUMMARY, state.subSummary, [{ agent: state.mainAgent, content: draft }]);

    // 发布初稿完成事件（Step 4 触发）
    this.eventBus.emit(SKILL_EVENTS.RESEARCH_DRAFT_FINISH, buildMessage({
      traceId,
      msgType: SKILL_EVENTS.RESEARCH_DRAFT_FINISH,
      senderAgent: 'skill:deep_research',
      taskInput: { draft_chars: draft.length },
    }));
  }

  // ============================================================
  // Step 4：跨模型独立审核（强隔离规则，定义 §三/§四 Step4）
  // ============================================================
  async _step4Review(state) {
    const { traceId } = state;
    let reviewer = this._pickReviewer(state);
    if (!reviewer) {
      // 极端兜底：无可用审核模型（仅主模型在线）——记录告警，跳过审核直接定稿
      CollabLogger.log('skill_dr_review_skipped', { trace_id: traceId, reason: '无可用独立审核模型' });
      this._phaseFail(state, state.subReview, '无可用独立审核模型，跳过审核');
      return this._emitReviewFinish(state, null);
    }
    state._reviewer = reviewer;

    const draft = blackboard.get(`blackboard:skill:deep_research:${traceId}:draft`) || {};
    const draftContent = (typeof draft === 'string' ? draft : draft.content) || '';
    const researches = blackboard.hgetall(`blackboard:skill:deep_research:${traceId}:sub_research`) || {};

    this._phaseStart(state, state.subReview, reviewer);

    const prompt = [
      `你是深度调研的独立审核模型（${reviewer}），你没有参与本次调研与撰写，请完全独立、客观地审核以下初稿，不继承任何撰写者的结论偏好。`,
      '',
      '审核维度：合规性、逻辑性、完整性、片面性、事实风险。',
      '输出审核报告，必须包含以下清单（逐条列出，没有问题的项写「无」）：',
      '1. 漏洞清单（论证漏洞/事实存疑）',
      '2. 逻辑问题',
      '3. 片面性问题（是否只呈现单方观点）',
      '4. 表述问题',
      '5. 缺失维度（调研素材中有但初稿未覆盖的内容）',
      '6. 优化建议',
      '7. 风险点',
      '',
      `用户需求：${state.userQuery}`,
      '',
      '=== 各模型调研素材（对照用） ===',
      Object.entries(researches).map(([dimName, r]) => (
        `【${dimName}】${typeof r === 'string' ? r : (r.output || '')}`
      )).join('\n\n'),
      '',
      '=== 待审核初稿 ===',
      draftContent,
    ].join('\n');

    let review;
    try {
      review = await this._callAgent(reviewer, prompt, state, '审核：独立评审');
    } catch (e) {
      // 审核模型失败：按隔离规则换人重试一次
      CollabLogger.log('skill_dr_review_fail', { trace_id: traceId, reviewer, error: e.message });
      const alt = this._pickReviewer(state, reviewer);
      if (alt && alt !== reviewer) {
        CollabLogger.log('skill_dr_review_retry', { trace_id: traceId, from: reviewer, to: alt });
        try {
          review = await this._callAgent(alt, prompt, state, '审核：独立评审（换模型重试）');
          state._reviewer = alt;
          this._phaseStart(state, state.subReview, alt);
        } catch (e2) {
          return this._emitReviewFinish(state, null);
        }
      } else {
        return this._emitReviewFinish(state, null);
      }
    }
    return this._emitReviewFinish(state, review);
  }

  /** 审核输出落库并发布事件（review 为 null 表示审核跳过/失败，直接终稿） */
  _emitReviewFinish(state, review) {
    const { traceId } = state;
    if (review) {
      blackboard.set(`blackboard:skill:deep_research:${traceId}:review`, {
        reviewer: state._reviewer || '（审核模型）', content: review, time: Date.now(),
      });
      this._phaseDone(state, state.subReview, state._reviewer || '', `审核完成（${review.length} 字意见）`);
      this._emitSubDone(state, TASK_TYPES.REVIEW, state.subReview, [{ agent: state._reviewer || '审核模型', content: review }]);
    }
    this.eventBus.emit(SKILL_EVENTS.REVIEW_RESULT_FINISH, buildMessage({
      traceId,
      msgType: SKILL_EVENTS.REVIEW_RESULT_FINISH,
      senderAgent: 'skill:deep_research',
      taskInput: { reviewed: !!review },
    }));
  }

  // ============================================================
  // Step 5：主模型按审核意见迭代修正，输出终稿
  // ============================================================
  async _step5Final(state) {
    const { traceId } = state;
    this._phaseStart(state, state.subFinal, state.mainAgent);

    const draft = blackboard.get(`blackboard:skill:deep_research:${traceId}:draft`) || {};
    const draftContent = (typeof draft === 'string' ? draft : draft.content) || '';
    const review = blackboard.get(`blackboard:skill:deep_research:${traceId}:review`) || {};
    const reviewContent = (typeof review === 'string' ? review : review.content) || '';
    const researches = blackboard.hgetall(`blackboard:skill:deep_research:${traceId}:sub_research`) || {};

    let prompt;
    if (reviewContent) {
      prompt = [
        '你是深度调研的主汇总模型，独立审核模型已对初稿提出审核意见，请逐条对照意见修订。',
        '',
        '要求：',
        '1. 逐条修正内容漏洞、补充缺失维度、优化逻辑、平衡观点、修正片面性',
        '2. 完成迭代改写，输出最终定稿（完整全文，不是差异说明）',
        '3. 保留初稿中经得起推敲的内容，不要为改而改',
        '',
        `用户需求：${state.userQuery}`,
        '',
        '=== 初稿 ===',
        draftContent,
        '',
        '=== 审核意见 ===',
        reviewContent,
        '',
        '=== 调研素材（补充论据用） ===',
        Object.entries(researches).map(([dimName, r]) => (
          `【${dimName}】${typeof r === 'string' ? r : (r.output || '')}`
        )).join('\n\n'),
      ].join('\n');
    } else {
      // 审核跳过：初稿即终稿，但仍要求主模型自查一次完整性
      prompt = [
        '你是深度调研的主汇总模型，请对以下初稿做最终定稿：自查逻辑与完整性，微调后输出完整终稿全文。',
        '',
        `用户需求：${state.userQuery}`,
        '',
        '=== 初稿 ===',
        draftContent,
      ].join('\n');
    }

    let finalText;
    try {
      finalText = await this._callAgent(state.mainAgent, prompt, state, '终稿：迭代修正');
    } catch (e) {
      // 终稿失败兜底：以初稿作为最终产出（素材与审核记录仍可溯源）
      CollabLogger.log('skill_dr_final_fallback_draft', { trace_id: traceId, error: e.message });
      finalText = draftContent || '';
      if (!finalText) return this._fail(state, `终稿生成失败：${e.message}`);
    }

    // 落库：最终定稿（含完整可溯源材料，定义 §四 Step5）
    blackboard.set(`blackboard:skill:deep_research:${traceId}:final`, {
      agent: state.mainAgent,
      content: finalText,
      reviewed: !!reviewContent,
      duration_ms: Date.now() - state.startTime,
      time: Date.now(),
    });
    this._phaseDone(state, state.subFinal, state.mainAgent, `终稿完成（${finalText.length} 字）`);

    const mainKey = `blackboard:task:${traceId}:main`;
    blackboard.hset(mainKey, 'overall_status', TASK_STATUS.SUCCESS);
    blackboard.hset(mainKey, 'final_result', finalText);
    blackboard.hset(mainKey, 'update_time', Date.now());
    CollabLogger.log('skill_dr_complete', {
      trace_id: traceId,
      task_id: state.externalTaskId,
      main_agent: state.mainAgent,
      researchers: state.researcherNames,
      reviewer: state._reviewer || null,
      dims: state.dimensions.map((d) => d.name),
      final_chars: finalText.length,
      duration_ms: Date.now() - state.startTime,
    });

    this._finish(state, TASK_STATUS.SUCCESS, finalText, '');
  }

  // ============================================================
  // 审核模型选取（强隔离规则，定义 §三）
  // ============================================================
  _pickReviewer(state, exclude) {
    const online = this._onlineAgents();
    // 1. 优先：本轮未参与任何环节的空闲模型
    const fresh = this._shuffle(online.filter((n) => !state.participants.has(n) && n !== exclude));
    if (fresh.length > 0) return fresh[0];
    // 2. 全员参与：禁止撰写主模型自审，从调研模型中轮换选取其他模型
    const candidates = [...state.participants].filter((n) => n !== state.mainAgent && n !== exclude && online.includes(n));
    if (candidates.length === 0) return null;
    const reviewer = candidates[this._rr % candidates.length];
    this._rr++;
    return reviewer;
  }

  // ============================================================
  // 基础设施辅助
  // ============================================================

  /** 在线模型列表（调度器画像优先，未初始化时回退配置全量） */
  _onlineAgents() {
    const fromProfiles = [];
    if (scheduler && scheduler.profiles) {
      for (const [name, p] of scheduler.profiles) {
        if (p.status !== 'offline') fromProfiles.push(name);
      }
    }
    if (fromProfiles.length > 0) return fromProfiles;
    return (config.agents || []).map((a) => a.name).filter((n) => AGENT_IDS[n]);
  }

  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * 调用模型（流式透传前端气泡 + 外层超时兜底）
   * @returns {Promise<string>} 模型输出内容
   */
  async _callAgent(agentName, instruction, state, roleLabel) {
    const streamId = uuidv4();
    eventBus.emit('agent:stream:start', { task_id: state.externalTaskId, agent: agentName, stream_id: streamId });
    const run = (async () => {
      try {
        const result = await agentRuntime.executeTaskWithAgent({
          task_id: state.traceId,
          role: roleLabel || 'executor',
          context: `深度调研（trace: ${state.traceId}）${roleLabel ? '· ' + roleLabel : ''}`,
          instruction,
          input_files: [],
        }, [], agentName, (chunk) => {
          eventBus.emit('agent:stream:chunk', { task_id: state.externalTaskId, agent: agentName, chunk, stream_id: streamId });
        });
        eventBus.emit('agent:stream:end', { task_id: state.externalTaskId, agent: agentName, stream_id: streamId });
        if (result && (result.status === 'failed' || result.error)) {
          throw new Error((result.error && result.error.message) || result.status || '模型调用失败');
        }
        return (result && result.content) || '';
      } catch (e) {
        eventBus.emit('agent:stream:end', { task_id: state.externalTaskId, agent: agentName, stream_id: streamId, error: e.message });
        throw e;
      }
    })();
    return Promise.race([
      run,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`模型 ${agentName} 调用超时（${CALL_TIMEOUT_MS / 1000}s）`)), CALL_TIMEOUT_MS)),
    ]);
  }

  /** 解析维度拆解输出（容错 JSON） */
  _parseDimensions(content) {
    if (!content || !content.trim()) return null;
    let text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let arr = null;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\[[\s\S]*\]/);
      if (m) {
        try { arr = JSON.parse(m[0]); } catch (e2) { arr = null; }
      }
    }
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const dims = arr
      .filter((d) => d && (d.name || d.dimension || d.goal))
      .map((d) => ({
        name: d.name || d.dimension || '未命名维度',
        goal: d.goal || d.objective || '',
        perspective: d.perspective || d.view || '',
        format: d.format || d.output_format || '',
      }));
    return dims.length >= 2 ? dims : null;
  }

  // ===== 子任务阶段面板（复用协作任务面板事件管线）=====

  _phaseSub(state, type, description, agent) {
    const seq = state.seq++;
    const subId = genSubTaskId(state.traceId, seq);
    const subKey = `blackboard:task:${state.traceId}:sub:${subId}`;
    blackboard.hset(subKey, 'sub_task_id', subId);
    blackboard.hset(subKey, 'trace_id', state.traceId);
    blackboard.hset(subKey, 'type', type);
    blackboard.hset(subKey, 'status', SUB_STATUS.PENDING);
    blackboard.hset(subKey, 'input', description);
    blackboard.hset(subKey, 'output', '');
    blackboard.hset(subKey, 'error_msg', '');
    blackboard.hset(subKey, 'retry_count', 0);
    blackboard.hset(subKey, 'max_retry', 1);
    blackboard.hset(subKey, 'start_time', 0);
    blackboard.hset(subKey, 'end_time', 0);
    blackboard.hset(subKey, 'role', type === TASK_TYPES.REVIEW ? 'reviewer' : 'executor');
    blackboard.hset(subKey, 'preferred_agent', agent || '');
    this._emitSubUpdate(state, subId, type, SUB_STATUS.PENDING, null, description);
    return subId;
  }

  _phaseStart(state, subId, agent) {
    const subKey = `blackboard:task:${state.traceId}:sub:${subId}`;
    const sub = blackboard.hgetall(subKey);
    blackboard.hset(subKey, 'status', SUB_STATUS.RUNNING);
    blackboard.hset(subKey, 'agent_id', agent ? (AGENT_IDS[agent] || agent) : '');
    blackboard.hset(subKey, 'start_time', Date.now());
    this._emitSubUpdate(state, subId, sub.type || '', SUB_STATUS.RUNNING, agent, sub.input || '');
  }

  _phaseDone(state, subId, agent, output) {
    const subKey = `blackboard:task:${state.traceId}:sub:${subId}`;
    const sub = blackboard.hgetall(subKey);
    blackboard.hset(subKey, 'status', SUB_STATUS.SUCCESS);
    blackboard.hset(subKey, 'agent_id', agent ? (AGENT_IDS[agent] || sub.agent_id || '') : (sub.agent_id || ''));
    blackboard.hset(subKey, 'output', output || '');
    blackboard.hset(subKey, 'end_time', Date.now());
    this._emitSubUpdate(state, subId, sub.type || '', SUB_STATUS.SUCCESS, agent, sub.input || '');
  }

  _phaseFail(state, subId, errorMsg) {
    const subKey = `blackboard:task:${state.traceId}:sub:${subId}`;
    const sub = blackboard.hgetall(subKey);
    blackboard.hset(subKey, 'status', SUB_STATUS.FAILED);
    blackboard.hset(subKey, 'error_msg', errorMsg || '失败');
    blackboard.hset(subKey, 'end_time', Date.now());
    this._emitSubUpdate(state, subId, sub.type || '', SUB_STATUS.FAILED, sub.agent_id || '', sub.input || '');
  }

  _emitSubUpdate(state, subId, type, status, agent, description) {
    this.eventBus.emit('collab:subtask:update', {
      task_id: state.externalTaskId,
      trace_id: state.traceId,
      sub_task_id: subId,
      type,
      status,
      agent: agent || '',
      description: description || '',
    });
  }

  /** 子任务完成 -> 写入对话展示（复用 orchestrator 的 collab:subtask:done 监听） */
  _emitSubDone(state, type, subId, agentsOutputs) {
    this.eventBus.emit('collab:subtask:done', {
      task_id: state.externalTaskId,
      trace_id: state.traceId,
      sub_task_id: subId,
      type,
      status: SUB_STATUS.SUCCESS,
      agents_outputs: agentsOutputs,
      errors: [],
    });
  }
}

const instance = new DeepResearchSkill();
module.exports = instance;
module.exports.DeepResearchSkill = DeepResearchSkill;
module.exports.defaultDimensions = defaultDimensions;
