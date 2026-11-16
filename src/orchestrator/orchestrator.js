const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const agentRuntime = require('../agent/runtime');
const eventBus = require('../eventbus/bus');
const config = require('../utils/config');
const blackboard = require('../blackboard/blackboard');
const scheduler = require('../engine/scheduler');
const procRegistry = require('../utils/proc-registry');
const sessionManager = require('../session/manager');
const CollabLogger = require('../utils/collab-logger');
const skillLoader = require('../skills/loader');
const sessionMemory = require('../memory/session-memory');
const memoryManager = require('../memory/memory-manager');
const { historyConfig } = require('../prompt/config');
const { enabledAgents, enabledAgentNames } = require('../utils/agent-list');
const { TASK_STATUS, TASK_TYPES, genSubTaskId } = require('../engine/events');
const messageLog = require('../messaging/message-log');
const { parseMentions } = require('../messaging/mention');
const renderer = require('../prompt/renderer');
const { isAgentFatal } = require('../utils/fatal-errors');
const collabModeRegistry = require('./collab-mode-registry');
const LogStore = require('../utils/log-store');

const ROOT = path.resolve(__dirname, '..', '..');

// 事件驱动协作：任务类型 → 中文标签
const COLLAB_TYPE_LABEL = {
  PLAN_TASK: '规划',
  CODE_TASK: '执行',
  REVIEW_TASK: '评审',
  SUMMARY_TASK: '汇总',
  DEBUG_TASK: '调试',
  RESEARCH_TASK: '调研',   // 深度调研 Skill：多角度并行调研
  FINAL_TASK: '终稿',      // 深度调研 Skill：迭代修正终稿
};

// 三类协作模式意图检测：用户明确指令触发，也可被模型自主 FC 调用
// 模型也可以向用户确认"要哪种模式"--在工具 description 里已说明
// 返回 { mode, topic }：mode 为模式名，topic 为去掉触发词后的实际讨论主题
function detectCollabMode(msg) {
  if (!msg || typeof msg !== 'string') return null;
  let m;
  const enabled = (mode) => collabModeRegistry.isEnabled(mode);
  // 匹配触发词（在消息开头）+ 可选的"一下/下/关于" + 剩余部分作为主题
  if (m = msg.match(/^(?:头脑风暴|发散思考|方案征集|创意发散|思路拓展|brainstorm)(?:一下|下|关于)?[\s,，：:]*/i)) {
    return enabled('brainstorm') ? { mode: 'brainstorm', topic: msg.substring(m[0].length).trim() || msg } : null;
  }
  if (m = msg.match(/^(?:多模型讨论|多方辩论|多Agent讨论|多智能体讨论|多角度论证|方案论证|debate)(?:一下|下|关于)?[\s,：:]*/i)) {
    return enabled('debate') ? { mode: 'debate', topic: msg.substring(m[0].length).trim() || msg } : null;
  }
  if (m = msg.match(/^(?:一对一讨论|一对一辩论|两个模型对一下|正反对抗|duel)(?:一下|下|关于)?[\s,：:]*/i)) {
    return enabled('duel') ? { mode: 'duel', topic: msg.substring(m[0].length).trim() || msg } : null;
  }
  return null;
}

/**
 * 自动事件驱动意图检测。
 *
 * 目标：用户没有显式点“事件驱动”开关时，也能把“多模型分工 / 多步骤拆解”类任务
 * 自动路由到 DAG 协作。
 *
 * 误判防护（项目里踩过触发词过窄、也踩过把知识问答误判）：
 *   - 纯解释/知识类问句开头直接排除；
 *   - “多智能体/多 Agent 系统”作为领域名词不算执行意图（要求“多个模型/多个智能体/多模型/团队”）；
 *   - 多模型路径必须同时出现动作词，并带分工/请求语义；
 *   - 显式讨论/辩论/头脑风暴关键词由 detectCollabMode 优先，自动路由会让位。
 *
 * @param {string} msg
 * @returns {boolean}
 */
function isEventDrivenIntent(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const text = msg.trim();
  if (!text) return false;

  // 纯知识/解释类问句不抢路由（含“如何…”“先解释…”这类咨询式表达）
  if (/^(解释|介绍|什么是|为什么|如何|讲讲|说明一下|科普|先(解释|说|讲|介绍|说明))/.test(text)) return false;

  const MULTI = /(多个|几个)(模型|智能体|agent)|多模型|团队|几位/i;
  const COLLAB = /分工|协作|分别|并行|一起|同时|接力|轮流/;
  const SELF_DECOMPOSE = /拆解|拆成|分成|分为|子任务|多步骤|分步骤|逐步|第一步/;
  const SEQUENCE = /先.*再|然后|接着|最后/;
  const ACTION = /调研|分析|实现|开发|编写|写|设计|评审|汇总|总结|落地|报告|方案|对比|排查|完成|给出|产出|处理/;
  const REQUEST = /帮我|请|帮忙|给我|替我|需要你|完成|实现|产出|做一份|写一份|生成|执行/;

  const hasMulti = MULTI.test(text);
  const hasCollab = COLLAB.test(text);
  const hasAction = ACTION.test(text);
  const hasRequest = REQUEST.test(text);

  // 明确要求“拆解/分成子任务”：本身就是分解意图
  if (SELF_DECOMPOSE.test(text)) return true;
  // “先调研，再写方案”这类分步执行意图
  if (SEQUENCE.test(text) && hasAction) return true;
  // “多个模型分工/一起做”这类多模型协作意图
  return hasMulti && hasAction && (hasCollab || hasRequest);
}

/**
 * 消息中是否出现三种协作模式的显式关键词（任意位置）。
 *
 * 自动事件驱动只应在“用户没有点名任何协作模式”时生效。
 * detectCollabMode 只匹配消息开头，无法覆盖“帮我用头脑风暴拆解一下”这类
 * 关键词出现在句中的表达；这里放宽到任意位置，用于让位，不做路由。
 *
 * @param {string} msg
 * @returns {boolean}
 */
function hasExplicitCollabModeKeyword(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const text = msg.trim();
  if (!text) return false;
  // brainstorm
  if (/头脑风暴|发散思考|方案征集|创意发散|思路拓展|\bbrainstorm\b/i.test(text)) return true;
  // debate
  if (/多模型讨论|多方辩论|多Agent讨论|多智能体讨论|多角度论证|方案论证|\bdebate\b/i.test(text)) return true;
  // duel
  if (/一对一讨论|一对一辩论|两个模型对一下|正反对抗|\bduel\b/i.test(text)) return true;
  return false;
}

/**
 * 自动事件驱动路由判定（纯函数，便于测试）。
 *
 * 显式意图永远优先：
 *   - 请求里显式指定 collab_mode
 *   - @了 2 个及以上模型（讨论模式）
 *   - @了单个模型（用户指定回答者）
 *   - 消息中出现三种协作模式的关键词（任意位置）
 *
 * @param {string} msg
 * @param {object} opts { collab_mode, discussion_agents, mentioned_agent }
 * @returns {boolean}
 */
function shouldAutoEventDriven(msg, opts = {}) {
  const hasDiscussion = Array.isArray(opts.discussion_agents) && opts.discussion_agents.length >= 2;
  const explicit = !!opts.collab_mode ||
    hasDiscussion ||
    !!opts.mentioned_agent ||
    hasExplicitCollabModeKeyword(msg);
  return !explicit && isEventDrivenIntent(msg);
}

/**
 * 任务编排器 (Task Orchestrator)
 *
 * 管理任务的完整生命周期：
 *   任务创建 → 复杂度判别 → Agent 执行 → 结果保存 → 状态更新
 */
class TaskOrchestrator {
  constructor() {
    this.taskDefaults = config.taskDefaults;
  }

  /**
   * 确保 tasks 目录及索引文件存在
   */
  _ensureIndex() {
    const tasksDir = path.join(ROOT, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      fs.mkdirSync(tasksDir, { recursive: true });
    }
    const indexPath = path.join(tasksDir, 'index.json');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, JSON.stringify([], null, 2));
    }
    return indexPath;
  }

  /**
   * 创建新任务
   */
  async createTask(params) {
    const taskId = params.task_id || uuidv4();
    const now = new Date().toISOString();

    const task = {
      task_id: taskId,
      name: params.name || '未命名任务',
      description: params.description || '',
      instruction: params.instruction || '',
      status: 'created',
      difficulty: 'unknown',
      priority: params.priority || 'medium',
      complex_flag: false,
      required_capabilities: params.required_capabilities || [],
      task_type: params.task_type || 'development',
      executor_agent: params.executor_agent || '克劳德',
      reviewer_agents: [],
      guardian_agent: null,
      progress: 0.0,
      revision_round: 0,
      max_revision_rounds: this.taskDefaults.max_revision_rounds || 3,
      suspend_reason: null,
      handover_from: null,
      handover_to: null,
      created_by: params.created_by || 'user_default',
      input_files: params.input_files || [],
      git_repo: config.git.default_repo_url || '',
      created_at: now,
      finished_at: null,
      updated_at: now,
    };

    // 创建任务目录
    const taskDir = path.join(ROOT, 'tasks', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'snapshots'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'outputs'), { recursive: true });

    // 初始化对话记录
    const conversationPath = path.join(taskDir, 'conversation.md');
    fs.writeFileSync(conversationPath, `# 对话记录 - ${task.name}\n\n**任务ID**: ${taskId}\n**创建时间**: ${now}\n**创建人**: ${params.created_by || 'user_default'}\n\n---\n\n`);

    // 保存任务文件
    this._saveTask(task);

    // 更新索引
    this._updateIndex(task);

    // 发送事件
    eventBus.emit('task:created', { task_id: taskId, name: task.name });

    return task;
  }
  async executeSimpleTask(taskId, userMessage, opts = {}) {
    const task = this._loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    let result = null;

    // 每次执行前把任务元数据同步为当前用户消息：
    // 避免旧任务名/描述（如误建为"1+1"）出现在模型上下文里误导模型
    // （模型会据此误以为当前任务仍是旧请求，答非所问）。
    try {
      if (userMessage) {
        task.name = (userMessage.length > 50 ? userMessage.substring(0, 50) + '...' : userMessage);
        task.description = userMessage;
        task.instruction = userMessage;
        this._saveTask(task);
      }
    } catch (e) { /* 忽略元数据同步失败 */ }

    try {
      // 确保协作事件监听（collab:planned / collab:subtask:done 等）始终注册：
      // deep_research 工具可能被普通聊天路径的模型调用（FC 循环），若监听未注册，
      // skill 的中间产出（各维度调研/初稿/审核）不会写入 conversation.md，
      // 前端流式气泡被清理后内容即消失（2026-08-27 复现）。幂等，仅首次生效。
      this._ensureEventDrivenEngine();
      // 会话级隔离：标记该对话的 session 活跃（独立 thread/session），复位上一轮取消标志
      sessionManager.get(taskId).beginTurn();

      // ===== 行首 @ 解析（多行）+ 承接规则 =====
      // 1) 行首 @ 1~2 个（每行各带独立任务）→ 指定承接
      // 2) 无 @ → 最近一次回复的 agent（粘性）
      // 3) 首次无 @ → 默认 agent（克劳德）
      const mentionCfg = config.mention || {};
      const maxUserMentions = Number(mentionCfg.user_max) || 2;
      const mentionParsed = parseMentions(userMessage || '', {
        max: maxUserMentions,
        agents: enabledAgents(),
        aliases: mentionCfg.aliases,
      });
      if (mentionParsed.error) {
        this._appendConversation(taskId, 'system', `[规则提示] ${mentionParsed.error.message}`);
        return {
          task,
          result: { status: 'failed', content: mentionParsed.error.message, error: mentionParsed.error },
          error: mentionParsed.error.message,
        };
      }

      const hasExplicitMention = (mentionParsed.mentions || []).length > 0;
      const body = mentionParsed.body || '';
      // 每个行首 @ 各带独立任务描述；body 是非 @ 的共享正文
      let jobs = (mentionParsed.mentions || []).map(m => ({
        agent: m.agent,
        instruction: body ? `${body}\n\n${m.description}` : m.description,
      }));
      // 只保留可用 agent（启用 + 在线 + 未熔断）
      jobs = jobs.filter(j => {
        if (!enabledAgentNames().includes(j.agent)) return false;
        if (isAgentFatal(j.agent)) return false;
        const st = agentRuntime.getAgentState(j.agent);
        return !st || st.online !== false;
      });
      if (jobs.length === 0) {
        // 无有效 @ → 最近一次回复的 agent（粘性）→ 默认 agent
        let fallbackAgent = null;
        const lastAgent = messageLog.latestAssistantAgent(taskId);
        if (lastAgent && enabledAgentNames().includes(lastAgent) && !isAgentFatal(lastAgent)) {
          const st = agentRuntime.getAgentState(lastAgent);
          if (!st || st.online !== false) fallbackAgent = lastAgent;
        }
        if (!fallbackAgent) {
          const def = config.getDefaultAgent();
          fallbackAgent = def ? def.name : '克劳德';
        }
        jobs = [{ agent: fallbackAgent, instruction: userMessage || task.instruction || task.description || '' }];
      }

      const execAgent = jobs[0].agent;
      const userRest = body || userMessage || task.instruction || task.description || '';

      // ===== 执行许可（operator approval）=====
      // 一律以用户消息为准；一旦本会话获得许可，后续轮次直接沿用。
      if (!task.operator_approved && this._detectOperatorApproval(userRest)) {
        task.operator_approved = true;
        task.operator_approved_at = new Date().toISOString();
        this._saveTask(task);
        this._appendConversation(taskId, 'system', '[执行许可] 用户已授权执行，后续可直接修改文件/实施方案');
      }
      if (execAgent !== task.executor_agent) {
        task.executor_agent = execAgent;
        this._saveTask(task);
      }

      task.status = 'executing';
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      eventBus.emit('task:executing', { task_id: taskId, agent: execAgent });

      // Memory：每轮对话前构建记忆上下文（Session 摘要 + Auto Memory 索引 + 相关主题），
      // 注入 Agent 推理上下文。task.memory_context 仅作为本次执行的运行态字段。
      try {
        task.memory_context = memoryManager.buildMemoryContext({
          taskId,
          projectId: 'multi-agent-platform',
          userInput: userMessage,
          taskName: task.name,
          taskDescription: task.description,
        });
      } catch (e) { /* 记忆构建失败不阻塞主流程 */ }

      // ===== 会话级稳定上下文（ZONE A）=====
      // 团队协作规则 / 会话目标 / 冻结的长期记忆在整个会话内保持不变，
      // 固定放在 prompt 前缀，保证每轮只有尾部（新对话内容）变化，
      // 供应商侧 KV 前缀缓存才能生效。
      try {
        task.stable_context = this._buildStableContext(task, userMessage);
        task.chat_mode = true;
        this._saveTask(task);
      } catch (e) { /* 稳定上下文构建失败不阻塞主流程 */ }

      // ===== 自动事件驱动意图路由 =====
      // 显式意图永远优先：指定了 collab_mode、@了 2+ 模型讨论、@了单个模型、
      // 或消息中出现讨论/辩论/头脑风暴关键词（任意位置）时，都不自动抢路由。
      // 判定逻辑抽到 shouldAutoEventDriven（纯函数，便于测试）。
      const autoRoutingEnabled = !(config.routing && config.routing.auto_event_driven === false);
      const autoEventDriven = autoRoutingEnabled && shouldAutoEventDriven(userMessage, {
        ...opts,
        // 显式 @ 了 agent 时，自动事件驱动让位
        mentioned_agent: hasExplicitMention ? execAgent : opts.mentioned_agent,
      });

      // 事件驱动协作模式（消息总线 + 黑板 + DAG 编排）
      if (opts.collab_mode === 'event-driven' || autoEventDriven) {
        if (autoEventDriven) opts.auto_triggered = true;
        result = await this._executeEventDrivenCollaboration(task, taskId, userRest, opts);
        return result;
      }

      // 多模型讨论模式：仅当显式开启且该模式未被注销
      if (collabModeRegistry.isEnabled('discussion')
        && opts.discussion_mode === true
        && opts.discussion_agents && Array.isArray(opts.discussion_agents)) {
        const valid = opts.discussion_agents.filter(n => enabledAgentNames().includes(n)); // 只允许已启用模型参与（吉米 enabled:false 自动排除）
        const unique = [...new Set(valid)];
        if (unique.length >= 2) {
          result = await this._executeDiscussionMode(task, taskId, userRest, unique);
          return result;
        }
      }

      // 三类协作模式（debate / brainstorm / duel）：
      // 1. 用户明确通过 collab_mode 指定 -> 直接走对应模式
      // 2. 模型自主调用 FC 工具（debate/brainstorm/duel）-> executor 层拦截后转入
      // 3. 关键词意图路由 -> 用户说"头脑风暴一下"/"多模型讨论一下"等自动触发
      //
      // 注意：这些模式已通过 config/collab-modes.yaml 注销（enabled: false）。
      // 代码保留，恢复时把对应开关置 true 即可；注销期间显式请求按普通对话处理。
      if (opts.collab_mode === 'debate' || opts.collab_mode === 'brainstorm' || opts.collab_mode === 'duel') {
        if (!collabModeRegistry.isEnabled(opts.collab_mode)) {
          this._appendConversation(
            taskId, 'system',
            `[已停用] 协作模式「${opts.collab_mode}」已注销，本轮按普通对话处理`
          );
        } else {
          // 记录用户消息
          this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description, { target: execAgent });
          if (opts.collab_mode === 'debate') {
            result = await this._executeDebateMode(task, taskId, userRest, opts);
          } else if (opts.collab_mode === 'brainstorm') {
            result = await this._executeBrainstormMode(task, taskId, userRest, opts);
          } else {
            result = await this._executeDuelMode(task, taskId, userRest, opts);
          }
          return result;
        }
      }

      // 关键词意图路由：用户消息明确包含模式关键词时自动触发
      {
        const intent = detectCollabMode(userMessage);
        if (intent && intent.mode && enabledAgentNames().length >= 2) {
          const topic = intent.topic || userMessage;
          this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description, { target: execAgent });
          this._appendConversation(taskId, 'system', `[协作模式] 检测到意图：${intent.mode}，讨论主题：${topic}`);
          if (intent.mode === 'debate') {
            result = await this._executeDebateMode(task, taskId, topic, { topic });
          } else if (intent.mode === 'brainstorm') {
            result = await this._executeBrainstormMode(task, taskId, topic, { topic });
          } else {
            result = await this._executeDuelMode(task, taskId, topic, { topic });
          }
          return result;
        }
      }

      result = await this._executeTurnWithJobs(task, taskId, userMessage, jobs);
      return result;
    } finally {
      // Session Memory 写入条件：
      //   1. 对话轮次超过 3 轮
      //   2. 累积对话内容超过 5K 字节（记录后重置缓冲）
      //   3. 对话结束（terminateTask 里单独触发）
      // 不满足条件时只累积，不触发 subagent 写入
      // 用户已停止本轮：跳过记忆写入，避免停止后台再次拉起模型调用
      if (!this._isCancelled(taskId)) {
      try {
        let agentOutput = '';
        if (result) {
          const r = result.result !== undefined ? result.result : result.content;
          agentOutput = (typeof r === 'string') ? r : ((r && r.content) || '');
        }
        // 累积对话内容到 session 运行态
        const sess = sessionManager.get(taskId);
        if (sess) {
          sess._dialogBuffer = (sess._dialogBuffer || '') +
            `[用户] ${userMessage || ''}\n[Agent] ${agentOutput}\n\n`;
          sess._dialogTurns = (sess._dialogTurns || 0) + 1;
          const bufSize = Buffer.byteLength(sess._dialogBuffer, 'utf8');
          if (sess._dialogTurns > 3 || bufSize > 5120) {
            // 满足条件：触发后台 subagent 写入
            this._writeSessionMemoryAsync(taskId, sess._dialogBuffer, task.executor_agent || '克劳德');
            // 重置缓冲
            sess._dialogBuffer = '';
            sess._dialogTurns = 0;
          }
        }
      } catch (e) { /* 忽略 */ }
      }
    }
  }

  /**
   * 构建会话级稳定上下文（ZONE A）。
   *
   * 整个会话内逐字节不变，内容包含：
   *   - 团队协作规则（@转交能力说明）
   *   - 会话目标（首条用户消息）
   *   - 冻结的长期记忆（Auto Memory）
   *
   * 注意：这里不能放任何“当轮检索”的内容（如按当前输入检索的 top 主题），
   * 否则每轮都会改变 prompt 前缀，KV 缓存会全部失效。
   */
  _buildStableContext(task, userMessage) {
    const cfg = historyConfig();
    if (!task.session_goal) {
      task.session_goal = userMessage || task.description || task.name || '';
    }
    if (cfg.freeze_memory_per_session) {
      if (!task.frozen_memory) task.frozen_memory = task.memory_context || '';
    } else {
      task.frozen_memory = task.memory_context || '';
    }

    // 团队协作 / @ 规则 / 执行许可 / 承接 / 会话目标 / 长期记忆
    // 全部由统一渲染器按模板文件生成（不同 Agent 用同一套模板，变量注入差异内容）。
    return renderer.buildStableContext({
      mentionMax: Number((config.mention || {}).model_max) || 2,
      availableAgents: enabledAgents(),
      sessionGoal: task.session_goal,
      memory: String(task.frozen_memory || '').trim(),
    });
  }

  /** 团队协作规则文本（只列当前已启用的模型；统一由模板渲染） */
  _buildTeamRules() {
    return renderer.buildStableContext({
      mentionMax: Number((config.mention || {}).model_max) || 2,
      availableAgents: enabledAgents(),
    });
  }

  /**
   * 异步写 Session Memory（后台 subagent）：
   * 把模板 + 当前累积的对话内容一起发给 subagent，
   * 让它按模板各节填充完整内容后输出完整 summary.md 正文，覆盖写回。
   * 加超时防挂起；超时/失败回退写 Worklog 条目。
   */
  _writeSessionMemoryAsync(taskId, dialogContent, agentName) {
    setImmediate(async () => {
      const prompt = sessionMemory.buildMemoryPrompt
        ? sessionMemory.buildMemoryPrompt({ userInput: '', agentOutput: dialogContent.slice(0, 8000) })
        : '请总结以下对话内容，按模板各节填写：\n' + dialogContent.slice(0, 4000);
      try {
        const r = await Promise.race([
          agentRuntime.executeTaskWithAgent({
            task_id: taskId,
            external_task_id: taskId,
            role: 'executor',
            context: '会话记忆摘要（后台 subagent）',
            instruction: prompt,
            input_files: [],
            disableTools: true,
            skip_incremental_context: true, // 后台维护调用：不注入对话增量上下文
          }, [], agentName || '克劳德'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('记忆摘要超时')), 60000)),
        ]);
        if (r && r.content && r.content.trim()) {
          sessionMemory.appendSummary(taskId, r.content.trim(), { agent: agentName || '克劳德' });
        } else {
          sessionMemory.writeWorklogEntry(taskId, dialogContent.slice(0, 200) || '(空)', { agent: agentName || '克劳德' });
        }
      } catch (e) {
        try {
          sessionMemory.writeWorklogEntry(taskId, dialogContent.slice(0, 200) || '(空)', { agent: agentName || '克劳德' });
        } catch (e2) { /* 忽略 */ }
      }
    });
  }

  /**
   * extract_memories：后台异步从 Session Memory 提炼长期记忆（用户偏好 / 项目知识 /
   * 决策 / 反馈 / 参考），写入 Auto Memory 项目级主题文件。
   * Session Memory 本身不注入 prompt，仅作为 Auto Memory 提取的原材料。
   */
  _extractMemoriesAsync(taskId, agentName) {
    setImmediate(async () => {
      try {
        const summary = sessionMemory.read(taskId);
        if (!summary || !summary.trim()) return;
        // 大模型提炼 memories（JSON 数组），失败则跳过（不阻塞）
        let memories = null;
        try {
          const prompt = [
            '你是长期记忆提炼助手。请从下面的会话摘要中，提炼出有长期留存价值的记忆，写入 Auto Memory。',
            '只提炼：用户偏好（user_preference）、项目知识/上下文（project_context）、决策（decision）、反馈（feedback）、参考信息（reference）。',
            '忽略：临时任务状态、一次性问答、无复用价值的寒暄。',
            '',
            '输出纯 JSON 数组（不要任何其他文字或 markdown 围栏），每项格式：',
            '{"name":"小写连字符标识","title":"人类可读标题","description":"简要描述","type":"user_preference|project_context|decision|feedback|reference","content":"记忆正文","tags":["标签"]}',
            '',
            '=== 会话摘要 ===',
            summary.slice(0, 6000),
          ].join('\n');
          const r = await Promise.race([
            agentRuntime.executeTaskWithAgent({
              task_id: taskId,
              external_task_id: taskId,
              role: 'executor',
              context: '长期记忆提炼（后台 extractMemories）',
              instruction: prompt,
              input_files: [],
              disableTools: true,
              skip_incremental_context: true, // 后台维护调用：不注入对话增量上下文
            }, [], agentName || '克劳德'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('记忆提炼超时')), 60000)),
          ]);
          const content = (r && r.content) || '';
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) memories = parsed;
          }
        } catch (e) { /* 提炼失败，跳过本轮 */ }

        if (memories && memories.length > 0) {
          await memoryManager.extractMemories(taskId, 'multi-agent-platform', () => memories);
        }
      } catch (e) { /* 忽略长期记忆提炼失败 */ }
    });
  }

  /**
   * 结束/终止任务（标记为 completed）
   */
  async terminateTask(taskId) {
    const task = this._loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === 'completed' || task.status === 'failed') {
      throw new Error(`Cannot terminate task with status: ${task.status}`);
    }
    task.status = 'completed';
    task.suspend_reason = '用户结束对话';
    task.progress = 1.0;
    task.finished_at = new Date().toISOString();
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);
    this._appendConversation(taskId, 'system', '对话已结束');

    // Session Memory：对话结束时触发写入（如果有未写入的缓冲内容）
    try {
      const sess = sessionManager.get(taskId);
      if (sess && sess._dialogBuffer && sess._dialogBuffer.trim()) {
        this._writeSessionMemoryAsync(taskId, sess._dialogBuffer, task.executor_agent || '克劳德');
        sess._dialogBuffer = '';
        sess._dialogTurns = 0;
      }
    } catch (e) { /* 忽略 */ }

    // Memory：会话终止时，将 Session Memory 摘要归档到 Auto Memory 项目 logs/
    // （5.4 会话终止流程第 3 步；失败不影响主流程）
    try {
      memoryManager.archiveSessionToLogs(taskId, 'multi-agent-platform', {
        title: `会话 ${task.name || taskId} 归档`,
        agent: task.executor_agent || '克劳德',
      });
    } catch (e) { /* 忽略归档失败 */ }

    // extract_memories：对话结束时后台提炼长期记忆（用户偏好/项目知识等）写入 Auto Memory
    try {
      this._extractMemoriesAsync(taskId, task.executor_agent || '克劳德');
    } catch (e) { /* 忽略 */ }

    eventBus.emit('task:completed', { task_id: taskId });
    const s = sessionManager.get(taskId);
    if (s) s.markCompleted();
    return task;
  }

  /**
   * 停止指定对话的所有任务/子任务（不影响其他对话）
   * 1. SIGKILL 该对话的 CLI 进程
   * 2. 取消该对话相关的调度器 trace
   * 3. 清空该对话的 session 状态
   */
  async stopTask(taskId) {
    const killed = procRegistry.killTask(taskId);
    // 取消该对话相关的调度器 trace
    const traces = [];
    for (const [traceId, p] of scheduler._pending) {
      if (p.taskId === taskId) traces.push(traceId);
    }
    for (const traceId of traces) scheduler.cancelTask(traceId);
    // 主动复位运行时 Agent 忙碌状态（不依赖 CLI 进程 promise 自然结束；
    // 仅释放本对话的调用，其他对话共用的模型不受影响）
    const released = agentRuntime.forceReleaseTask(taskId);
    // 标记「本轮已停止」（与「结束对话」区分，编排层据此不再推进后续步骤）
    const s = sessionManager.get(taskId);
    if (s) { s.busyAgents.clear(); s.traces = []; s.cancel(); }
    CollabLogger.log('task_stopped', {
      task_id: taskId, killed_procs: killed,
      cancelled_traces: traces.length, released_calls: released,
    });
    eventBus.emit('task:stopped', { task_id: taskId, scope: 'turn', killed_procs: killed, released_calls: released });
    return { task_id: taskId, status: 'stopped', killed_procs: killed, cancelled_traces: traces.length, released_calls: released };
  }

  /**
   * 当前对话本轮是否已被用户停止。
   * 编排层在每个「下一步」前调用，防止停止后继续拉起模型。
   */
  _isCancelled(taskId) {
    return sessionManager.isCancelled(taskId);
  }

  /**
   * 判断用户消息是否构成“执行许可”。
   * 只认用户本人消息（调用方传入的是用户原话），模型之间的建议不算。
   */
  _detectOperatorApproval(text) {
    if (!text) return false;
    const s = String(text).trim();
    // 问句不算许可（例如「可以开始执行吗？」未被回答前不应视为授权）
    if (/[吗么]\s*[？?]?\s*$/.test(s) && !/授权/.test(s)) return false;
    const patterns = [
      /(可以|允许|同意|批准|授权)(开始|执行|实现|修改|动手|落地|实施|改|做)/,
      /按(这个|上述|上面的|该|此)?方案(执行|做|改|实施|落地|开始)/,
      /(开始|直接|马上)(执行|实现|修改|动手|落地|实施)/,
      /授权/,
      /(改|做|实现|落地)吧/,
      /^(好|可以|行|没问题)[，,。！!\s]*(开始|执行|做|改|实施|落地|干)/,
      /(干吧|上吧|开工|动手)/,
    ];
    return patterns.some(re => re.test(s));
  }

  /**
   * 停止当前所有任务/子任务
   * 1. SIGKILL 所有在跑模型 CLI 进程
   * 2. 取消调度器所有在跑 trace
   * 3. 清空所有会话 session
   * 4. 把所有 executing 任务标记 completed
   */
  async stopAllTasks() {
    const killed = procRegistry.killAll();
    const stoppedCollab = scheduler.stopAll();
    const stoppedSessions = sessionManager.stopAll();

    const tasks = this.getTasks({ status: 'executing' });
    let completedCount = 0;
    for (const t of tasks) {
      try {
        await this.terminateTask(t.task_id);
        completedCount += 1;
      } catch (e) { /* 已结束的跳过 */ }
    }

    eventBus.emit('tasks:stop-all', {
      stopped_collab: stoppedCollab,
      killed_procs: killed,
      completed_tasks: completedCount,
      stopped_sessions: stoppedSessions,
    });
    return { stopped_collab: stoppedCollab, killed_procs: killed, completed_tasks: completedCount, stopped_sessions: stoppedSessions };
  }

  getTasks(filter = {}) {
    const tasks = this._loadIndex();
    let filtered = [...tasks];

    if (filter.status) {
      filtered = filtered.filter(t => t.status === filter.status);
    }
    if (filter.difficulty) {
      filtered = filtered.filter(t => t.difficulty === filter.difficulty);
    }
    if (filter.created_by) {
      filtered = filtered.filter(t => t.created_by === filter.created_by);
    }

    // 排序
    const sortField = filter.sort_by || 'created_at';
    const sortOrder = filter.sort_order || 'desc';
    filtered.sort((a, b) => {
      const va = a[sortField] || '';
      const vb = b[sortField] || '';
      return sortOrder === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
    });

    return filtered;
  }

  /**
   * 获取单个任务详情
   */
  getTask(taskId) {
    return this._loadTask(taskId);
  }

  /**
   * 获取任务对话记录
   */
  getConversation(taskId) {
    const conversationPath = path.join(ROOT, 'tasks', taskId, 'conversation.md');
    if (!fs.existsSync(conversationPath)) return '';
    return fs.readFileSync(conversationPath, 'utf8');
  }

  /**
   * 获取任务输出文件列表
   */
  getOutputFiles(taskId) {
    const outputDir = path.join(ROOT, 'tasks', taskId, 'outputs');
    if (!fs.existsSync(outputDir)) return [];
    return fs.readdirSync(outputDir).map(f => ({
      name: f,
      path: path.join('tasks', taskId, 'outputs', f),
      size: fs.statSync(path.join(outputDir, f)).size,
    }));
  }

  /**
   * 批量导出任务
   */
  exportTasks(taskIds) {
    const results = [];
    for (const taskId of taskIds) {
      const taskDir = path.join(ROOT, 'tasks', taskId);
      if (!fs.existsSync(taskDir)) continue;

      const task = this._loadTask(taskId);
      const conversation = this.getConversation(taskId);
      const outputs = this.getOutputFiles(taskId);

      results.push({
        task,
        conversation,
        outputs,
        task_dir: `tasks/${taskId}/`,
      });
    }
    return results;
  }

  /**
   * 批量删除任务
   */
  async deleteTasks(taskIds, userId) {
    const deleted = [];
    const failed = [];

    for (const taskId of taskIds) {
      const task = this._loadTask(taskId);
      if (!task) {
        // 残留索引兜底：task.json 已丢失但 index.json 仍有条目（如目录被外部清理）。
        // 此时直接清理索引条目，而不是报"任务不存在"阻塞删除。
        const indexEntry = this._loadIndex().find(t => t.task_id === taskId);
        if (indexEntry) {
          const dir = path.join(ROOT, 'tasks', taskId);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          // 连带删除该会话的日志文件（logs/<日期>/<task_id>.log）
          LogStore.deleteSessionLogs(taskId);
          deleted.push({ task_id: taskId, name: indexEntry.name || '未命名对话', residual: true });
          eventBus.emit('task:deleted', { task_id: taskId });
          continue;
        }
        failed.push({ task_id: taskId, reason: '任务不存在' });
        continue;
      }

      // 权限检查
      const isAdmin = config.isAdmin(userId);
      const isOwner = task.created_by === userId;
      if (!isAdmin && !isOwner) {
        failed.push({ task_id: taskId, name: task.name, reason: '无权限：仅创建者或管理员可删除' });
        continue;
      }

      // 删除任务目录
      const taskDir = path.join(ROOT, 'tasks', taskId);
      if (fs.existsSync(taskDir)) {
        fs.rmSync(taskDir, { recursive: true, force: true });
      }
      // 连带删除该会话的日志文件（logs/<日期>/<task_id>.log）
      LogStore.deleteSessionLogs(taskId);

      deleted.push({ task_id: taskId, name: task.name });
      eventBus.emit('task:deleted', { task_id: taskId });
    }

    // 更新索引
    if (deleted.length > 0) {
      const tasks = this._loadIndex();
      const filtered = tasks.filter(t => !deleted.find(d => d.task_id === t.task_id));
      this._saveIndex(filtered);
    }

    return { deleted, failed };
  }

  // === 内部方法 ===

  _saveTask(task) {
    const taskPath = path.join(ROOT, 'tasks', task.task_id, 'task.json');
    // 运行态字段不落盘：stable_context 含记忆正文，history_segments 可能很大，
    // 它们每轮都会重建，持久化只会让 task.json 膨胀。
    const {
      stable_context, history_segments, record_transcript, memory_context,
      ...persisted
    } = task;
    fs.writeFileSync(taskPath, JSON.stringify(persisted, null, 2));
  }

  _loadTask(taskId) {
    const taskPath = path.join(ROOT, 'tasks', taskId, 'task.json');
    if (!fs.existsSync(taskPath)) return null;
    return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  }

  _loadIndex() {
    const indexPath = path.join(ROOT, 'tasks', 'index.json');
    if (!fs.existsSync(indexPath)) return [];
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }

  _saveIndex(tasks) {
    const indexPath = path.join(ROOT, 'tasks', 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(tasks, null, 2));
  }

  _updateIndex(task) {
    const tasks = this._loadIndex();
    const idx = tasks.findIndex(t => t.task_id === task.task_id);
    const entry = {
      task_id: task.task_id,
      name: task.name,
      status: task.status,
      difficulty: task.difficulty,
      priority: task.priority,
      complex_flag: task.complex_flag,
      executor_agent: task.executor_agent,
      progress: task.progress,
      created_by: task.created_by,
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
    if (idx >= 0) {
      tasks[idx] = entry;
    } else {
      tasks.push(entry);
    }
    this._saveIndex(tasks);
  }

  _appendConversation(taskId, role, content, opts = {}) {
    const conversationPath = path.join(ROOT, 'tasks', taskId, 'conversation.md');
    const timestamp = new Date().toISOString();
    let roleLabel = {
      'user': '🧑 用户',
      'assistant': '🤖 助手',
      'system': '⚙️ 系统',
    }[role] || role;

    // 模型间转交的问题：发送方标记为模型名（如「🤖 吉米 @钱文」）
    if (opts.from && role === 'user') {
      roleLabel = `🤖 ${opts.from}`;
    }
    // 模型回复转交给其他模型：回复方标记为模型名（如「🤖 克劳德 @吉米」）
    if (opts.from && role === 'assistant') {
      roleLabel = `🤖 ${opts.from}`;
    }

    // 思考内容只进 conversation.md（展示用，前端渲染为折叠块）；
    // 不进 messageLog，避免思考文本污染多轮上下文。
    // [THINKING] 必须插在 "**模型名**" 前缀之后，保持模型名在消息最前，
    // 否则前端无法识别发送者、方向标签会回退成默认"克劳德"。
    const reasoning = (opts.reasoning && String(opts.reasoning).trim()) || '';
    let displayContent = content;
    if (reasoning && role === 'assistant') {
      const prefixMatch = String(content || '').match(/^\*\*[^*]+\*\*\s*/);
      if (prefixMatch) {
        displayContent = prefixMatch[0] + `[THINKING]\n${reasoning}\n[/THINKING]\n\n` + String(content || '').slice(prefixMatch[0].length);
      } else {
        displayContent = `[THINKING]\n${reasoning}\n[/THINKING]\n\n${content}`;
      }
    }

    const entry = `\n### ${roleLabel}${opts.target ? ` @${opts.target}` : ''} - ${timestamp}\n\n${displayContent}\n\n---\n`;
    fs.appendFileSync(conversationPath, entry);

    // 机器可读日志：游标与增量 prompt 的唯一依据（conversation.md 只用于展示）
    try {
      let agent = opts.agent || null;
      if (!agent && role === 'assistant') {
        if (opts.from) agent = opts.from;
        else {
          const m = String(content || '').match(/^\*\*(克劳德|吉米|迪普斯克|钱文)\*\*/);
          if (m) agent = m[1];
        }
      }
      messageLog.append(taskId, {
        role,
        agent,
        kind: opts.kind || 'chat',
        content: String(content == null ? '' : content),
        visible_to: opts.visible_to || null,
        turn_id: opts.turn_id || null,
        from_agent: opts.from_agent || null,
      });
    } catch (e) { /* 日志写入失败不影响对话展示 */ }
  }

  _readConversationHistory(taskId) {
    const conversationPath = path.join(ROOT, 'tasks', taskId, 'conversation.md');
    if (!fs.existsSync(conversationPath)) return [];
    const raw = fs.readFileSync(conversationPath, 'utf8');
    const messages = [];
    // 真正的消息头：行首 "### 🧑 用户/🤖 助手/⚙️ 系统/🤖 模型名"
    // 不能用 split(/\n### /) —— 回答正文里的 markdown 标题（### xxx）会被误分割
    const headerRe = /^### (🧑 用户|🤖 助手|⚙️ 系统|🤖 (克劳德|吉米|迪普斯克|钱文))(?: @[^\n-]+)?[^\n]*$/gm;
    const starts = [];
    let m;
    while ((m = headerRe.exec(raw)) !== null) {
      starts.push({ pos: m.index, role: m[1], agent: m[2] || null, headerLen: m[0].length });
    }
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const bodyStart = s.pos + s.headerLen;
      const bodyEnd = i + 1 < starts.length ? starts[i + 1].pos : raw.length;
      const body = raw.slice(bodyStart, bodyEnd).replace(/^\n+/, '');
      const content = body.replace(/\n---\n?$/, '').trim();
      if (!content) continue;

      let role = 'unknown';
      if (s.role.includes('用户')) role = 'user';
      else if (s.role.includes('助手')) role = 'assistant';
      else if (s.role.includes('系统')) role = 'system';
      else if (s.agent) role = 'user'; // 模型间转交的问题，视为提问

      messages.push({ role, content });
    }
    return messages;
  }
}


// 从单独文件加载大方法（拆分文件，每个<800行）
Object.assign(TaskOrchestrator.prototype, require('./collab'));
Object.assign(TaskOrchestrator.prototype, require('./execution'));
Object.assign(TaskOrchestrator.prototype, require('./collab-modes'));

module.exports = new TaskOrchestrator();
// 供路由测试直接引用
module.exports.isEventDrivenIntent = isEventDrivenIntent;
module.exports.hasExplicitCollabModeKeyword = hasExplicitCollabModeKeyword;
module.exports.shouldAutoEventDriven = shouldAutoEventDriven;
