/**
 * 三类协作模式调度逻辑（从 orchestrator.js 提取，通过 prototype 赋值接入）
 * 方法内的 this 指向 TaskOrchestrator 实例
 *
 * 三种模式：
 * - debate（多方辩论）：6轮，并行观点 -> 交叉点评 -> 自我辩解 -> 二次点评 -> 终修正 -> 收敛
 * - brainstorm（头脑风暴）：3轮，差异化发散 -> 分层收敛 -> 终极收敛
 * - duel（一对一辩论）：2-5轮，交替对抗
 *
 * 所有中间输出存黑板（全量 + 结构化摘要），模型按需用 fetch_full 工具拉取全量。
 */
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const eventBus = require('../eventbus/bus');
const blackboard = require('../blackboard/blackboard');
const agentRuntime = require('../agent/runtime');
const { enabledAgentNames, enabledAgents } = require('../utils/agent-list');
const { genTraceId } = require('../engine/events');
const sessionManager = require('../session/manager');

const ROOT = path.resolve(__dirname, '..', '..');

// 讨论超时（秒）
const DISC_TIMEOUT_MS = 120000;
// 最大重发次数
const MAX_RETRY = 3;
// 历史摘要分层裁剪：最近 N 条给完整摘要
const RECENT_FULL_SUMMARY_COUNT = 3;

// ===== 结构化消息块标记 =====
const DISC_MSG_RE = /\[DISCUSSION_MSG\]\s*([\s\S]*?)\s*\[\/DISCUSSION_MSG\]/;
const JSON_BLOCK_RE = /```(?:json)?\s*(\{[\s\S]*?"core_view"[\s\S]*?\})\s*```/;
const RAW_JSON_RE = /(\{[^{}]*"core_view"[^{}]*\})/;

/**
 * 解析模型输出中的结构化讨论消息块
 * 支持三种格式：[DISCUSSION_MSG]{json}[/DISCUSSION_MSG] / ```json {json} ``` / 裸 JSON 对象
 * fullText 为去掉结构化块后的纯正文
 */
function parseDiscMsg(content) {
  const defaultSummary = {
    core_view: '', key_points: [], questions: [],
    status: 'success', reply_to: null, converged: false,
  };
  if (!content) return { summary: defaultSummary, fullText: '' };

  let summary = Object.assign({}, defaultSummary);
  let fullText = content;
  let matched = false;

  // 1. 优先匹配 [DISCUSSION_MSG]...[/DISCUSSION_MSG]
  let m = content.match(DISC_MSG_RE);
  if (m) {
    try { summary = Object.assign(summary, JSON.parse(m[1].trim())); matched = true; } catch (e) {}
    fullText = content.replace(DISC_MSG_RE, '');
  }

  // 2. 匹配 ```json {json} ```
  if (!matched) {
    m = content.match(JSON_BLOCK_RE);
    if (m) {
      try { summary = Object.assign(summary, JSON.parse(m[1].trim())); matched = true; } catch (e) {}
      fullText = content.replace(JSON_BLOCK_RE, '');
    }
  }

  // 3. 匹配裸 JSON 对象（含 core_view 字段）
  if (!matched) {
    m = content.match(RAW_JSON_RE);
    if (m) {
      try { summary = Object.assign(summary, JSON.parse(m[0])); matched = true; } catch (e) {}
      fullText = content.replace(RAW_JSON_RE, '');
    }
  }

  // 清理 fullText：去掉残留的标记/代码块符号
  fullText = fullText
    .replace(/\[DISCUSSION_MSG\]/g, '')
    .replace(/\[\/DISCUSSION_MSG\]/g, '')
    .replace(/```(?:json)?\s*$/g, '')
    .replace(/^\s*```(?:json)?\s*\n/gm, '')
    .trim();

  return { summary, fullText };
}

module.exports = {

  // ===== 通用原语 =====

  /**
   * 初始化讨论元数据到黑板
   */
  _initDiscMeta(traceId, taskId, topic, mode, participants) {
    const metaKey = `blackboard:disc:${traceId}:meta`;
    blackboard.hset(metaKey, 'trace_id', traceId);
    blackboard.hset(metaKey, 'task_id', taskId);
    blackboard.hset(metaKey, 'topic', topic);
    blackboard.hset(metaKey, 'mode', mode);
    blackboard.hset(metaKey, 'participants', JSON.stringify(participants));
    blackboard.hset(metaKey, 'current_round', '0');
    blackboard.hset(metaKey, 'msg_seq', '0');
    blackboard.hset(metaKey, 'status', 'running');
    blackboard.hset(metaKey, 'iteration', '0');
    blackboard.hset(metaKey, 'created_at', new Date().toISOString());
  },

  /**
   * 生成下一个消息序号
   */
  _nextMsgSeq(traceId) {
    const metaKey = `blackboard:disc:${traceId}:meta`;
    const cur = parseInt(blackboard.hget(metaKey, 'msg_seq') || '0', 10);
    const next = cur + 1;
    blackboard.hset(metaKey, 'msg_seq', String(next));
    return next;
  },

  /**
   * 存储一条讨论消息（全量 + 摘要）到黑板
   */
  _storeDiscMsg(traceId, msgSeq, sender, round, summary, fullText) {
    const fullKey = `blackboard:disc:${traceId}:full:${msgSeq}`;
    const summaryKey = `blackboard:disc:${traceId}:summary:${msgSeq}`;
    blackboard.set(fullKey, fullText);
    blackboard.hset(summaryKey, 'msg_seq', String(msgSeq));
    blackboard.hset(summaryKey, 'sender', sender);
    blackboard.hset(summaryKey, 'round', String(round));
    blackboard.hset(summaryKey, 'core_view', summary.core_view || '');
    blackboard.hset(summaryKey, 'key_points', JSON.stringify(summary.key_points || []));
    blackboard.hset(summaryKey, 'questions', JSON.stringify(summary.questions || []));
    blackboard.hset(summaryKey, 'status', summary.status || 'success');
    blackboard.hset(summaryKey, 'reply_to', String(summary.reply_to || ''));
    blackboard.hset(summaryKey, 'converged', String(!!summary.converged));
    blackboard.hset(summaryKey, 'full_key', fullKey);
    blackboard.hset(summaryKey, 'created_at', new Date().toISOString());
    return { fullKey, summaryKey };
  },

  /**
   * 读取历史摘要列表（分层裁剪：最近 N 条完整，更早仅精简字段）
   */
  _getHistorySummaries(traceId, excludeMsgSeqs) {
    const exclude = new Set((excludeMsgSeqs || []).map(String));
    const prefix = `blackboard:disc:${traceId}:summary:`;
    const keys = blackboard.keys(prefix);
    const all = keys.map(k => {
      const s = blackboard.hgetall(k);
      if (!s || !s.msg_seq) return null;
      return s;
    }).filter(Boolean).sort((a, b) => parseInt(a.msg_seq) - parseInt(b.msg_seq));

    const total = all.length;
    return all.map((s, idx) => {
      if (exclude.has(String(s.msg_seq))) return null;
      const isRecent = idx >= total - RECENT_FULL_SUMMARY_COUNT;
      const base = {
        msg_seq: s.msg_seq,
        sender: s.sender,
        round: s.round,
        status: s.status,
        full_key: s.full_key,
        core_view: s.core_view || '',
      };
      if (isRecent) {
        base.key_points = s.key_points || '[]';
        base.questions = s.questions || '[]';
        base.converged = s.converged;
      }
      return base;
    }).filter(Boolean);
  },

  /**
   * 拼装讨论 context（注入给执行者模型）
   */
  _buildDiscContext(traceId, instruction, deps, round, mode) {
    const metaKey = `blackboard:disc:${traceId}:meta`;
    const meta = blackboard.hgetall(metaKey) || {};
    const topic = meta.topic || '';
    const history = this._getHistorySummaries(traceId, deps);

    let ctx = `=== 讨论信息 ===\n主题：${topic}\n模式：${mode}\n当前轮次：${round}\n\n`;

    if (history.length > 0) {
      ctx += `=== 历史摘要 ===\n`;
      for (const h of history) {
        const points = h.key_points ? `（要点：${h.key_points}）` : '';
        const qs = h.questions && h.questions !== '[]' ? `（疑问：${h.questions}）` : '';
        ctx += `[${h.sender}#${h.msg_seq} 全量:${h.full_key}] ${h.core_view}${points}${qs} [${h.status}]\n`;
      }
      ctx += `\n`;
    }

    // 依赖消息的完整摘要
    if (deps && deps.length > 0) {
      ctx += `=== 本轮上游消息（你需回应的内容） ===\n`;
      for (const depSeq of deps) {
        const depSummary = blackboard.hgetall(`blackboard:disc:${traceId}:summary:${depSeq}`);
        if (depSummary && depSummary.msg_seq) {
          ctx += `[${depSummary.sender}#${depSummary.msg_seq} 全量:${depSummary.full_key}]\n`;
          ctx += `核心观点：${depSummary.core_view || ''}\n`;
          if (depSummary.key_points && depSummary.key_points !== '[]') {
            ctx += `关键论据：${depSummary.key_points}\n`;
          }
          if (depSummary.questions && depSummary.questions !== '[]') {
            ctx += `疑问：${depSummary.questions}\n`;
          }
          ctx += `\n`;
        }
      }
      ctx += `如需查看某条上游消息的完整正文，可调用 fetch_full 工具（参数 key=full_key）。\n\n`;
    }

    ctx += `=== 你的任务 ===\n${instruction}\n\n`;
    ctx += `=== 输出要求 ===\n`;
    ctx += `你的输出必须分为两部分：\n\n`;
    ctx += `第一部分：完整观点正文\n`;
    ctx += `直接写出你的完整回答/观点/分析。这部分是用户会看到的内容，不要包含任何 JSON、标记或代码块。\n\n`;
    ctx += `第二部分：结构化摘要\n`;
    ctx += `必须放在回复的最末尾，用 [DISCUSSION_MSG] 和 [/DISCUSSION_MSG] 标记包裹，标记内是纯 JSON（不要用代码块包裹）：\n\n`;
    ctx += `[DISCUSSION_MSG]\n{"core_view":"核心观点1-3句话","key_points":["关键论据1","关键论据2"],"questions":["待讨论的疑问"],"status":"success","converged":false}\n[/DISCUSSION_MSG]\n\n`;
    ctx += `规则：\n`;
    ctx += `- 正文在前，结构化块在最后，两者之间用空行分隔\n`;
    ctx += `- 正文部分不要出现 [DISCUSSION_MSG]、[/DISCUSSION_MSG]、代码块等任何标记\n`;
    ctx += `- 结构化块必须在回复的最后一行\n`;
    ctx += `- status 取值：success 或 failed\n`;
    ctx += `- converged：你认为讨论是否已收敛（true/false）\n`;

    return ctx;
  },

  /**
   * 执行一轮讨论：扇出并行调用各执行者，barrier 回收
   * @param {string} traceId 讨论ID
   * @param {string} taskId 外部对话ID
   * @param {Array} taskList [{ executor, instruction, deps }]
   * @param {number} round 当前轮次
   * @param {string} mode 讨论模式
   * @returns {Array} 本轮所有消息摘要
   */
  async _discRound(traceId, taskId, taskList, round, mode) {
    // 检查是否被取消（stopTask 会设 session.status='completed'）
    const sess = sessionManager.get(taskId);
    if (sess && sess.status === 'completed') {
      console.log(`[DiscRound] 任务 ${taskId} 已取消，跳过第${round}轮`);
      return [];
    }

    const metaKey = `blackboard:disc:${traceId}:meta`;
    blackboard.hset(metaKey, 'current_round', String(round));

    eventBus.emit('disc:round:start', { traceId, round, mode, participants: taskList.map(t => t.executor) });

    const results = await Promise.allSettled(taskList.map(async (t) => {
      // 子任务执行前再次检查是否被取消
      const s2 = sessionManager.get(taskId);
      if (s2 && s2.status === 'completed') {
        return { msgSeq: 0, executor: t.executor, summary: { status: 'failed', core_view: '已取消' }, fullText: '已取消' };
      }
      const msgSeq = this._nextMsgSeq(traceId);
      const ctx = this._buildDiscContext(traceId, t.instruction, t.deps || [], round, mode);

      // 流式事件
      const streamId = uuidv4();
      eventBus.emit('agent:stream:start', { task_id: taskId, agent: t.executor, stream_id: streamId });

      try {
        const result = await agentRuntime.executeTaskWithAgent({
          task_id: `disc_${traceId}_${msgSeq}`,
          external_task_id: taskId,
          trace_id: traceId,
          role: 'executor',
          context: ctx,
          instruction: t.instruction,
          input_files: [],
          disableTools: false, // 允许 fetch_full
        }, [], t.executor, (chunk) => {
          eventBus.emit('agent:stream:chunk', { task_id: taskId, agent: t.executor, chunk, stream_id: streamId });
        });

        eventBus.emit('agent:stream:end', { task_id: taskId, agent: t.executor, stream_id: streamId });

        const content = (result && result.content) || '';
        const parsed = parseDiscMsg(content);
        const summary = parsed.summary;
        summary.reply_to = t.deps && t.deps.length > 0 ? t.deps[0] : null;
        if (result && (result.status === 'failed' || result.error)) {
          summary.status = 'failed';
        }

        this._storeDiscMsg(traceId, msgSeq, t.executor, round, summary, parsed.fullText || '(无正文输出)');
        // 即时写入对话记录：系统提示后紧接模型输出，取消会话也不丢内容
        // 只写 fullText（不含结构化块），用户只看到正文
        this._appendConversation(taskId, 'assistant', `**${t.executor}**（第${round}轮）\n\n${parsed.fullText || '(无正文输出)'}`);
        return { msgSeq, executor: t.executor, summary, fullText: parsed.fullText || content };
      } catch (e) {
        eventBus.emit('agent:stream:end', { task_id: taskId, agent: t.executor, stream_id: streamId, error: e.message });
        const summary = {
          core_view: '', key_points: [], questions: [],
          status: 'failed', reply_to: t.deps && t.deps.length > 0 ? t.deps[0] : null,
          converged: false,
        };
        this._storeDiscMsg(traceId, msgSeq, t.executor, round, summary, `执行失败：${e.message}`);
        this._appendConversation(taskId, 'assistant', `**${t.executor}**（第${round}轮）执行失败\n\n${e.message}`);
        return { msgSeq, executor: t.executor, summary, fullText: `执行失败：${e.message}` };
      }
    }));

    const summaries = results.map(r => r.value || { summary: { status: 'failed' } });
    eventBus.emit('disc:round:done', { traceId, round, summaries });
    return summaries;
  },

  /**
   * 检查是否所有参与者都标记 converged
   */
  _checkAllConverged(summaries) {
    if (!summaries || summaries.length === 0) return false;
    return summaries.every(s => s && s.summary && s.summary.converged);
  },

  /**
   * 从黑板读取某轮的所有摘要
   */
  _getRoundSummaries(traceId, round) {
    const prefix = `blackboard:disc:${traceId}:summary:`;
    const keys = blackboard.keys(prefix);
    return keys.map(k => blackboard.hgetall(k))
      .filter(s => s && s.round === String(round))
      .sort((a, b) => parseInt(a.msg_seq) - parseInt(b.msg_seq));
  },

  // ===== 模式一：多方辩论（6轮可迭代）=====

  async _executeDebateMode(task, taskId, userMessage, opts = {}) {
    const traceId = genTraceId('debate');
    const enabled = enabledAgentNames();
    // 参与者：用户指定或自动选取3-5个已启用模型
    let participants = [];
    if (opts.participants) {
      participants = opts.participants.split(',').map(s => s.trim()).filter(n => enabled.includes(n));
    }
    if (participants.length < 3) {
      participants = enabled.slice(0, Math.min(5, Math.max(3, enabled.length)));
    }
    if (participants.length < 3) {
      throw new Error(`多方辩论至少需要3个已启用模型，当前可用：${enabled.join('、')}`);
    }
    const topic = opts.topic || userMessage || task.instruction || '';

    this._initDiscMeta(traceId, taskId, topic, 'debate', participants);
    this._appendConversation(taskId, 'system', `[多方辩论启动] 主题：${topic} | 参与模型：${participants.join('、')} | 共6轮`);
    eventBus.emit('disc:start', { traceId, taskId, mode: 'debate', topic, participants });
    task.status = 'executing';
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);

    let finalSummaries = [];

    try {
      {

        // 第一轮：并行观点发散
        this._appendConversation(taskId, 'system', `[多方辩论 第1轮] 并行观点发散`);
        const r1 = await this._discRound(traceId, taskId,
          participants.map(a => ({ executor: a, instruction: `基于主题「${topic}」输出你的完整初始观点。包含：核心观点、支撑依据、潜在局限、适用场景。各Agent观点独立，不互相参考。`, deps: [] })),
          1, 'debate');
        finalSummaries = r1;

        // 第二轮：交叉匿名点评（禁止自评）
        this._appendConversation(taskId, 'system', `[多方辩论 第2轮] 交叉匿名点评`);
        const r1MsgSeqs = r1.map(s => s.msgSeq);
        const r2TaskList = participants.map((a, i) => {
          // 分配点评对象：每个Agent点评下一个Agent（环形），禁止自评
          const targetIdx = (i + 1) % participants.length;
          const target = participants[targetIdx];
          const targetSeq = r1MsgSeqs[targetIdx];
          return { executor: a, instruction: `点评以下观点（来自${target}），指出逻辑漏洞、论据缺陷、对立观点、补充建议。禁止点评自身。`, deps: [targetSeq] };
        });
        const r2 = await this._discRound(traceId, taskId, r2TaskList, 2, 'debate');

        // 第三轮：自我辩解 + 观点初修正
        this._appendConversation(taskId, 'system', `[多方辩论 第3轮] 自我辩解+初修正`);
        // 检查分支优化：若所有点评无分歧且观点完全统一 -> 跳过第四轮
        const allNoDivergence = r2.every(s => s.summary && s.summary.converged);
        const r3TaskList = participants.map((a, i) => {
          // 找出针对该Agent的点评消息
          const reviews = r2.filter(s => s.executor === a).map(s => s.msgSeq);
          return { executor: a, instruction: `针对以下点评逐一回应辩解，区分合理建议与无效质疑，吸收有效意见，输出修正版观点。`, deps: reviews };
        });
        const r3 = await this._discRound(traceId, taskId, r3TaskList, 3, 'debate');

        // 第四轮：二次交叉点评（除非分支优化跳过）
        let r4 = [];
        if (!allNoDivergence) {
          this._appendConversation(taskId, 'system', `[多方辩论 第4轮] 二次交叉点评`);
          const r3MsgSeqs = r3.map(s => s.msgSeq);
          const r4TaskList = participants.map((a, i) => {
            const targetIdx = (i + 1) % participants.length;
            const target = participants[targetIdx];
            const targetSeq = r3MsgSeqs[targetIdx];
            return { executor: a, instruction: `针对修正后的新观点（来自${target}）进行二次点评，聚焦残留争议、未解决分歧、新产生的逻辑问题。`, deps: [targetSeq] };
          });
          r4 = await this._discRound(traceId, taskId, r4TaskList, 4, 'debate');
        } else {
          this._appendConversation(taskId, 'system', `[多方辩论 第4轮] 跳过（观点已统一）`);
        }

        // 第五轮：终修正 + 共识分歧拆解
        this._appendConversation(taskId, 'system', `[多方辩论 第5轮] 终修正+共识分歧拆解`);
        const allReviewSeqs = [...r2.map(s => s.msgSeq), ...r4.map(s => s.msgSeq)];
        const r5TaskList = participants.map((a, i) => {
          return { executor: a, instruction: `整合第二轮和第四轮的全部有效信息，二次修正自身观点。统一输出：全员共识清单、核心分歧清单、未解决争议点、各自立场总结。`, deps: allReviewSeqs };
        });
        const r5 = await this._discRound(traceId, taskId, r5TaskList, 5, 'debate');
        finalSummaries = r5;
      }


      // 收敛：主模型汇总
      const allFinal = finalSummaries.map(s => `【${s.executor}】${s.summary.core_view || s.fullText}`).join('\n\n');
      const summary = `### 🤖 助手 - ${new Date().toISOString()}\n\n**多方辩论结果**\n\n讨论主题：${topic}\n参与模型：${participants.join('、')}\n迭代次数：1\n\n各Agent最终观点：\n${allFinal}\n\n---\n`;

      // 写入对话
      const conversationPath = path.join(ROOT, 'tasks', taskId, 'conversation.md');
      const fs = require('fs');
      fs.appendFileSync(conversationPath, summary);

      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'finished');
      eventBus.emit('disc:converged', { traceId, consensus: allFinal, divergences: '' });
      eventBus.emit('disc:end', { traceId, taskId, mode: 'debate' });

      task.progress = 1.0;
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      return { task, result: { status: 'success', content: allFinal } };
    } catch (e) {
      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'failed');
      eventBus.emit('disc:failed', { traceId, error: e.message });
      task.status = 'failed';
    // 被用户取消时不标记 failed，优雅返回
    const _sess = sessionManager.get(taskId);
    if (_sess && _sess.status === 'completed') {
      this._appendConversation(taskId, 'system', '[讨论已取消]');
      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'cancelled');
      eventBus.emit('disc:end', { traceId, taskId });
      task.status = 'completed';
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      return { task, result: { status: 'success', content: '讨论已取消' } };
    }
    task.suspend_reason = e.message;

      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      throw e;
    }
  },

  // ===== 模式二：头脑风暴（3轮）=====

  async _executeBrainstormMode(task, taskId, userMessage, opts = {}) {
    const traceId = genTraceId('brainstorm');
    const enabled = enabledAgentNames();
    const topic = opts.topic || userMessage || task.instruction || '';

    // 发散层：3+个Agent
    let divergeAgents = [];
    if (opts.participants) {
      divergeAgents = opts.participants.split(',').map(s => s.trim()).filter(n => enabled.includes(n));
    }
    if (divergeAgents.length < 3) {
      divergeAgents = enabled.slice(0, Math.min(5, Math.max(3, enabled.length)));
    }
    if (divergeAgents.length < 3) {
      throw new Error(`头脑风暴至少需要3个已启用模型，当前可用：${enabled.join('、')}`);
    }

    // 收敛层：1-2个不参与发散的Agent
    const convergeAgents = enabled.filter(n => !divergeAgents.includes(n));
    // 终收敛：1个不参与发散和收敛的Agent（或取收敛层第一个）
    const allAgents = enabled;
    let finalAgent = convergeAgents[0] || enabled[0];

    const participants = [...divergeAgents, ...convergeAgents.filter(a => !divergeAgents.includes(a))];
    this._initDiscMeta(traceId, taskId, topic, 'brainstorm', participants);
    this._appendConversation(taskId, 'system', `[头脑风暴启动] 主题：${topic} | 发散层：${divergeAgents.join('、')} | 共3轮`);
    eventBus.emit('disc:start', { traceId, taskId, mode: 'brainstorm', topic, participants });
    task.status = 'executing';
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);

    try {
      // 差异化维度
      const dimensions = ['优势分析', '风险分析', '落地思路', '创新方案', '问题短板'];
      const dimAssign = divergeAgents.map((a, i) => dimensions[i % dimensions.length]);

      // 第一轮：定向差异化发散
      this._appendConversation(taskId, 'system', `[头脑风暴 第1轮] 定向差异化发散`);
      const r1TaskList = divergeAgents.map((a, i) => ({
        executor: a,
        instruction: `从【${dimAssign[i]}】维度思考主题「${topic}」，输出完整观点、方案、思路。你的专属维度是${dimAssign[i]}，请聚焦此维度。`,
        deps: [],
      }));
      const r1 = await this._discRound(traceId, taskId, r1TaskList, 1, 'brainstorm');
      const r1MsgSeqs = r1.map(s => s.msgSeq);

      // 第二轮：分层首次收敛
      this._appendConversation(taskId, 'system', `[头脑风暴 第2轮] 分层首次收敛`);
      let r2;
      if (divergeAgents.length < 4) {
        // 1个收敛Agent汇总全部
        const convAgent = convergeAgents[0] || divergeAgents[0];
        r2 = await this._discRound(traceId, taskId, [{
          executor: convAgent,
          instruction: `汇总以下${divergeAgents.length}组发散观点，输出初步共识、分歧、整合方案。`,
          deps: r1MsgSeqs,
        }], 2, 'brainstorm');
      } else {
        // 2个收敛Agent分组收敛
        const half = Math.ceil(divergeAgents.length / 2);
        const convA = convergeAgents[0] || enabled[0];
        const convB = convergeAgents[1] || convergeAgents[0] || enabled[0];
        r2 = await this._discRound(traceId, taskId, [
          { executor: convA, instruction: `汇总前${half}组观点，输出初步共识、分歧、整合方案。`, deps: r1MsgSeqs.slice(0, half) },
          { executor: convB, instruction: `汇总后${divergeAgents.length - half}组观点，输出初步共识、分歧、整合方案。`, deps: r1MsgSeqs.slice(half) },
        ], 2, 'brainstorm');
      }
      const r2MsgSeqs = r2.map(s => s.msgSeq);

      // 第三轮：终极二次收敛
      this._appendConversation(taskId, 'system', `[头脑风暴 第3轮] 终极二次收敛`);
      const r3 = await this._discRound(traceId, taskId, [{
        executor: finalAgent,
        instruction: `对以下收敛结果进行合并、去重、补全、择优，输出唯一、完整、可落地的最终综合结论。剔除无效观点、合并重复思路、保留优质创意、补齐逻辑短板。`,
        deps: r2MsgSeqs,
      }], 3, 'brainstorm');

      // 收敛
      const finalContent = r3[0] && r3[0].fullText || '';
      const summaryText = `### 🤖 助手 - ${new Date().toISOString()}\n\n**头脑风暴结果**\n\n讨论主题：${topic}\n发散层：${divergeAgents.join('、')}\n\n最终综合结论：\n${finalContent}\n\n---\n`;
      const conversationPath = path.join(ROOT, 'tasks', taskId, 'conversation.md');
      const fs = require('fs');
      fs.appendFileSync(conversationPath, summaryText);

      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'finished');
      eventBus.emit('disc:converged', { traceId, consensus: finalContent });
      eventBus.emit('disc:end', { traceId, taskId, mode: 'brainstorm' });

      task.progress = 1.0;
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      return { task, result: { status: 'success', content: finalContent } };
    } catch (e) {
      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'failed');
      eventBus.emit('disc:failed', { traceId, error: e.message });
      task.status = 'failed';
    // 被用户取消时不标记 failed，优雅返回
    const _sess = sessionManager.get(taskId);
    if (_sess && _sess.status === 'completed') {
      this._appendConversation(taskId, 'system', '[讨论已取消]');
      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'cancelled');
      eventBus.emit('disc:end', { traceId, taskId });
      task.status = 'completed';
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      return { task, result: { status: 'success', content: '讨论已取消' } };
    }
    task.suspend_reason = e.message;

      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      throw e;
    }
  },

  // ===== 模式三：一对一辩论（2-5轮可变）=====

  async _executeDuelMode(task, taskId, userMessage, opts = {}) {
    const traceId = genTraceId('duel');
    const enabled = enabledAgentNames();
    const topic = opts.topic || userMessage || task.instruction || '';

    // 两个Agent
    let agentA = opts.agent_a || enabled[0] || '克劳德';
    let agentB = opts.agent_b || enabled[1] || enabled.find(n => n !== agentA) || '迪普斯克';
    // 确保不同
    if (agentA === agentB) {
      agentB = enabled.find(n => n !== agentA) || agentA;
    }
    if (agentA === agentB) {
      throw new Error('一对一辩论需要2个不同的模型');
    }

    const participants = [agentA, agentB];
    this._initDiscMeta(traceId, taskId, topic, 'duel', participants);
    this._appendConversation(taskId, 'system', `[一对一辩论启动] 主题：${topic} | ${agentA} vs ${agentB} | 2-5轮`);
    eventBus.emit('disc:start', { traceId, taskId, mode: 'duel', topic, participants });
    task.status = 'executing';
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);

    const minRounds = 2;
    const maxRounds = 5;
    let round = 0;
    let lastSummaries = [];

    try {
      // 第1轮：A输出核心观点
      this._appendConversation(taskId, 'system', `[一对一辩论 第1轮] ${agentA} 输出核心观点`);
      const r1 = await this._discRound(traceId, taskId, [{
        executor: agentA,
        instruction: `基于主题「${topic}」输出你的核心观点、支撑依据。`,
        deps: [],
      }], 1, 'duel');
      lastSummaries = r1;

      // 交替对抗
      let currentAgent = agentB;
      let prevSeq = r1[0].msgSeq;

      for (round = 2; round <= maxRounds; round++) {
        const otherAgent = currentAgent === agentA ? agentB : agentA;
        this._appendConversation(taskId, 'system', `[一对一辩论 第${round}轮] ${currentAgent} 回应${otherAgent}`);
        const r = await this._discRound(traceId, taskId, [{
          executor: currentAgent,
          instruction: `针对以下观点进行点评、反驳、补充或辩解修正。`,
          deps: [prevSeq],
        }], round, 'duel');
        lastSummaries = r;
        prevSeq = r[0].msgSeq;
        currentAgent = otherAgent;

        // 收敛判定：达到最小轮次且双方都标记converged
        if (round >= minRounds && this._checkAllConverged(r)) break;
      }

      // 收尾总结：由agentA统筹
      this._appendConversation(taskId, 'system', `[一对一辩论 收尾] ${agentA} 总结`);
      const allMsgSeqs = [];
      const prefix = `blackboard:disc:${traceId}:summary:`;
      const keys = blackboard.keys(prefix);
      keys.forEach(k => {
        const s = blackboard.hgetall(k);
        if (s && s.msg_seq) allMsgSeqs.push(parseInt(s.msg_seq));
      });
      allMsgSeqs.sort((a, b) => a - b);

      const summaryRound = await this._discRound(traceId, taskId, [{
        executor: agentA,
        instruction: `统筹总结双方共识、核心分歧、各自坚守立场、问题最终结论。`,
        deps: allMsgSeqs,
      }], round + 1, 'duel');

      const finalContent = summaryRound[0] && summaryRound[0].fullText || '';
      const summaryText = `### 🤖 助手 - ${new Date().toISOString()}\n\n**一对一辩论结果**\n\n讨论主题：${topic}\n${agentA} vs ${agentB}\n交互轮次：${round}\n\n最终结论：\n${finalContent}\n\n---\n`;
      const conversationPath = path.join(ROOT, 'tasks', taskId, 'conversation.md');
      const fs = require('fs');
      fs.appendFileSync(conversationPath, summaryText);

      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'finished');
      eventBus.emit('disc:converged', { traceId, consensus: finalContent });
      eventBus.emit('disc:end', { traceId, taskId, mode: 'duel' });

      task.progress = 1.0;
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      return { task, result: { status: 'success', content: finalContent } };
    } catch (e) {
      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'failed');
      eventBus.emit('disc:failed', { traceId, error: e.message });
      task.status = 'failed';
    // 被用户取消时不标记 failed，优雅返回
    const _sess = sessionManager.get(taskId);
    if (_sess && _sess.status === 'completed') {
      this._appendConversation(taskId, 'system', '[讨论已取消]');
      blackboard.hset(`blackboard:disc:${traceId}:meta`, 'status', 'cancelled');
      eventBus.emit('disc:end', { traceId, taskId });
      task.status = 'completed';
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      return { task, result: { status: 'success', content: '讨论已取消' } };
    }
    task.suspend_reason = e.message;

      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      throw e;
    }
  },
};
