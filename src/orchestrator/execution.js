/**
 * Agent 执行方法（从 orchestrator.js 提取，通过 prototype 赋值接入）
 * 方法内的 this 指向 TaskOrchestrator 实例
 *
 * 保留：@ 转交接力链（_executeTurnWithJobs / _runAgentWithHandoff / _streamedExecute）
 * 已删除：讨论模式与辩论/头脑风暴/对局（2026-11-16）
 */
const eventBus = require('../eventbus/bus');
const agentRuntime = require('../agent/runtime');
const config = require('../utils/config');
const { enabledAgents } = require('../utils/agent-list');
const { parseMentions } = require('../messaging/mention');
const { buildIncrementalContext } = require('../prompt/incremental');
const cursorStore = require('../messaging/cursor-store');
const renderer = require('../prompt/renderer');
const CollabLogger = require('../utils/collab-logger');

module.exports = {

  /**
   * 用户停止本轮后的统一收尾：
   * 写系统提示、记录 stopped 状态，但不把任务标为 failed/completed（对话仍可继续）。
   */
  _finishStoppedTurn(task, taskId) {
    this._appendConversation(taskId, 'system', '[本轮已停止] 用户停止了本轮任务，对话仍可继续');
    // 只停止本轮：任务保持 executing，用户可以直接继续输入
    task.status = 'executing';
    task.last_run_status = 'stopped';
    delete task.suspend_reason;
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);
    eventBus.emit('task:stopped', { task_id: taskId, scope: 'turn' });
    return { task, result: { status: 'cancelled', content: '' }, stopped: true };
  },

  /**
   * 从模型回复中解析行首 @ 转交请求（多行）。
   *
   * 规则：
   *   - 每个 agent 一次最多 @ 2 个其他 agent，且不能 @ 自己；
   *   - 每个 @ 必须带任务描述（写在 @ 的下一行）；
   *   - @ 只能出现在回复最前端或最末端；代码块/表格/引用等非纯文本里的 @ 不识别。
   *
   * @param {string} content 模型回复全文
   * @param {string} currentAgent 当前发言的 agent（排除自己）
   * @returns {{mentions:Array<{agent:string,description:string}>, body:string, error?:{code:string,message:string}}}
   */
  _extractMentionsFromReply(content, currentAgent) {
    const cfg = config.mention || {};
    return parseMentions(content || '', {
      max: Number(cfg.model_max) || 2,
      agents: enabledAgents(),
      aliases: cfg.aliases,
      currentAgent,
    });
  },

  /**
   * 一轮对话：把用户消息分发给 1~2 个 agent（共享同一指令，向后兼容入口），
   * 并处理模型行首 @ 的转交链（最多 max_hops 跳）。
   */
  async _executeTurnWithAgents(task, taskId, displayMessage, instruction, agents) {
    return this._executeTurnWithJobs(
      task, taskId, displayMessage,
      agents.map(a => ({ agent: a, instruction })),
    );
  },

  /**
   * 一轮对话：按 job 分发（每个 agent 各带独立指令），
   * 并处理模型行首 @ 的转交链。
   * @param {Array<{agent:string, instruction:string}>} jobs
   */
  async _executeTurnWithJobs(task, taskId, displayMessage, jobs) {
    const cfg = config.mention || {};
    const maxSpawns = Number(cfg.max_spawns_per_turn) || 16;
    // A2A 链深度上限（原文 15）；兼容旧配置 max_hops
    const maxDepth = Number(cfg.max_a2a_depth) || Number(cfg.max_hops) || 15;
    const roundMode = String(cfg.mode || 'parallel');
    const ppCfg = cfg.pingpong || {};

    // 本轮上下文：召唤序号 / 每个 agent 的召唤次数 / 乒乓计数（pairKey → 往返次数）
    const turnCtx = {
      turnId: 'turn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      summonSeq: 0,
      summonCount: {},
      pingpong: {},
      warnThreshold: Number(ppCfg.warn_threshold) || 2,
      blockThreshold: Number(ppCfg.block_threshold) || 4,
      summonMaxPerAgent: Number(cfg.summon_max_per_agent) || 4,
      recentFiles: null, // 每轮只采样一次
      // 并行轮：多个 agent 独立作答同一问题，@ 无路由语义（只对本轮生效）
      parallelRound: roundMode === 'parallel' && jobs.length >= 2,
      parallelNotified: false,
    };

    this._appendConversation(taskId, 'user', displayMessage, {
      target: jobs.map(j => j.agent).join('、'),
      turn_id: turnCtx.turnId,
    });

    const budget = { left: maxSpawns };
    // 不再使用 visited 集合：同一 agent 可被多次召唤，由乒乓计数 + 召唤上限治理
    const runOne = (job, hop) => this._runAgentWithHandoff(
      task, taskId, job.agent, job.instruction, hop, budget, maxDepth, turnCtx, null
    );

    const settled = await Promise.allSettled(jobs.map(j => runOne(j, 0)));
    const results = settled.map(r => (r.status === 'fulfilled'
      ? r.value
      : { ok: false, error: (r.reason && r.reason.message) || '执行失败' }));

    if (this._isCancelled(taskId) || results.some(r => r && r.stopped)) {
      return this._finishStoppedTurn(task, taskId);
    }

    const okResults = results.filter(r => r && r.ok);
    if (okResults.length === 0) {
      task.status = 'failed';
      task.suspend_reason = results.map(r => r && r.error).filter(Boolean).join('; ') || '执行失败';
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      return { task, result: { status: 'failed', content: '', error: task.suspend_reason } };
    }

    task.status = 'executing';
    delete task.suspend_reason;
    task.last_run_status = 'completed';
    task.executor_agent = jobs[jobs.length - 1] ? jobs[jobs.length - 1].agent : (jobs[0] && jobs[0].agent);
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);
    eventBus.emit('task:updated', { task_id: taskId, status: task.status });

    if (okResults.length < results.length) {
      const failed = results.filter(r => r && !r.ok && r.error).map(r => r.error);
      if (failed.length) this._appendConversation(taskId, 'system', `[部分失败] ${failed.join('; ')}`);
    }

    return {
      task,
      result: { status: 'success', content: okResults.map(r => r.content).join('\n\n---\n\n') },
    };
  },

  /**
   * 单个 agent 的执行 + 行首 @ 转交链（最多 @ 2 个，并行扇出）。
   *
   * 动态上下文（agent → agent 转交时）：
   *   - assembleIncrementalContext 组装六段式增量上下文（来源/模式/导航/触发原文/未读/系统提示）
   *   - 乒乓治理：同一对 agent 本轮来回 ≥ warn_threshold 注入警告，≥ block_threshold 阻断
   *   - delivery_cursor：成功后推进，失败/阻断不推进
   *
   * @param {Object} turnCtx 本轮上下文（召唤计数/乒乓计数）
   * @param {Object|null} meta { fromAgent, triggerContent, mentionDesc, chain }
   */
  async _runAgentWithHandoff(task, taskId, agentName, instruction, hop, budget, maxHops, turnCtx, meta) {
    if (this._isCancelled(taskId)) return { ok: false, stopped: true };
    if (budget.left <= 0) return { ok: false, error: `已达到单轮 spawn 上限（${agentName}）` };

    const turn = turnCtx || {
      turnId: 'turn_adhoc', summonSeq: 0, summonCount: {}, pingpong: {},
      warnThreshold: 2, blockThreshold: 4, summonMaxPerAgent: 4, recentFiles: null,
      parallelRound: false, parallelNotified: false,
    };
    const fromAgent = (meta && meta.fromAgent) || null;
    const pairKey = fromAgent ? [fromAgent, agentName].sort().join('|') : null;

    // ===== 乒乓治理：同一对 agent 的往返计数（仅 agent → agent 转交计入）=====
    if (pairKey) {
      const nextPair = (turn.pingpong[pairKey] || 0) + 1;
      if (nextPair >= turn.blockThreshold) {
        turn.pingpong[pairKey] = nextPair;
        const blockText = renderer.render('context/pingpong_block', {
          from_agent: fromAgent,
          target_agent: agentName,
          pair_count: nextPair,
          block_threshold: turn.blockThreshold,
        });
        this._appendConversation(taskId, 'system', blockText.trim());
        CollabLogger.log('pingpong_block', {
          task_id: taskId, trace_id: task.trace_id || '',
          from: fromAgent, to: agentName,
          pair_count: nextPair, threshold: turn.blockThreshold,
        });
        return { ok: false, blocked: true };
      }
      turn.pingpong[pairKey] = nextPair;
    }

    // ===== 每个 agent 单轮召唤上限（与乒乓计数互补，防稀疏星形爆炸）=====
    const nextSummonCount = (turn.summonCount[agentName] || 0) + 1;
    if (nextSummonCount > turn.summonMaxPerAgent) {
      this._appendConversation(taskId, 'system',
        `[召唤上限] ${agentName} 本轮已被召唤 ${nextSummonCount - 1} 次（上限 ${turn.summonMaxPerAgent}），已阻断本次转交`);
      return { ok: false, blocked: true };
    }
    turn.summonCount[agentName] = nextSummonCount;
    turn.summonSeq += 1;
    const summonSeq = turn.summonSeq;

    budget.left -= 1;

    // 接力链（用户 → … → 触发者），供导航头与后续分支使用
    const chain = (meta && Array.isArray(meta.chain) && meta.chain.length)
      ? meta.chain
      : (fromAgent ? ['用户', fromAgent] : ['用户']);

    // ===== 增量上下文（agent → agent 转交时显式组装，携带接力链与乒乓计数）=====
    // 用户直呼等其余场景由 runtime 通用入口自动组装（见 runtime.executeTaskWithAgent）。
    let incrementalContext = '';
    let deliveredUpTo = 0;
    if (fromAgent && meta && meta.triggerContent) {
      const pairCount = pairKey ? (turn.pingpong[pairKey] || 0) : 0;
      try {
        const ctxResult = buildIncrementalContext({
          task,
          agentName,
          agentRuntime,
          fromAgent,
          triggerContent: meta.triggerContent,
          mentionDesc: meta.mentionDesc,
          chain,
          turn: {
            summonSeq,
            hop,
            chain,
            pairCount,
            warn: pairCount >= turn.warnThreshold,
            warnThreshold: turn.warnThreshold,
            blockThreshold: turn.blockThreshold,
            modeLabel: (config.mention && config.mention.mode === 'serial') ? '串行接力模式' : '并行接力模式',
          },
        });
        incrementalContext = ctxResult.prompt;
        deliveredUpTo = ctxResult.deliveredUpTo;
        CollabLogger.log('delivery', {
          task_id: taskId, trace_id: task.trace_id || '',
          from: fromAgent, to: agentName,
          path: ctxResult.stats.path,
          unread_count: ctxResult.stats.unread_count,
          dropped: ctxResult.stats.dropped_msgs,
          pair_count: pairCount,
          summon_seq: summonSeq,
          warn: ctxResult.stats.warn,
        });
      } catch (e) {
        // 组装失败降级：不带增量上下文继续（不阻塞转交）
        incrementalContext = '';
        console.error(`[Execution] 增量上下文组装失败（${agentName}）:`, e.message);
      }
    }

    // 并行分发时不能修改共享 task.instruction（会互相覆盖），用浅拷贝隔离。
    // 执行许可提示由 runtime 统一注入（delta/full 两种模式都能生效）。
    const taskForAgent = Object.assign({}, task, { instruction });
    // 触发元信息：runtime 在 resume 生效时据此重建 delta 增量内容（只发未读+指令+警告）
    const pairCountForTask = pairKey ? (turn.pingpong[pairKey] || 0) : 0;
    taskForAgent.trigger_from = fromAgent || '用户';
    taskForAgent.trigger_content = (meta && meta.triggerContent) || instruction;
    taskForAgent.mention_desc = (meta && meta.mentionDesc) || (fromAgent ? '' : instruction);
    taskForAgent.trigger_chain = chain;
    taskForAgent.incremental_turn = {
      summonSeq,
      hop,
      pairCount: pairCountForTask,
      warn: pairCountForTask >= turn.warnThreshold,
      warnThreshold: turn.warnThreshold,
      blockThreshold: turn.blockThreshold,
      modeLabel: (config.mention && config.mention.mode === 'serial') ? '串行接力模式' : '并行接力模式',
    };
    if (incrementalContext) taskForAgent.incremental_context = incrementalContext;

    let result;
    try {
      result = await this._streamedExecute(taskForAgent, taskId, agentName, []);
    } catch (e) {
      result = { status: 'failed', error: { message: e.message } };
    }

    if (this._isCancelled(taskId)) return { ok: false, stopped: true };
    if (!result || result.status === 'cancelled') return { ok: false, stopped: true };
    if (result.status !== 'success') {
      return { ok: false, error: `${agentName}: ${(result.error && result.error.message) || '执行失败'}` };
    }

    // 投递成功：推进该 agent 的投递游标（失败/阻断不推进）
    if (incrementalContext && deliveredUpTo > 0) {
      try { cursorStore.advanceDeliveryCursor(taskId, agentName, deliveredUpTo); } catch (e) { /* 游标失败不影响主流程 */ }
    }

    const content = result.content || '';
    // 实质工作重置乒乓：输出 >200 字或调用过工具 → 这对 agent 的往返计数归零；
    // 纯路由动作（@ / 持球）不重置；用户新消息天然重置整轮计数（turnCtx 每轮新建）
    if (pairKey && (String(content).length > 200 || Number(result.tool_rounds) > 0)) {
      turn.pingpong[pairKey] = 0;
    }
    // 落库时记录 agent，游标才能“排除自身输出”
    // reasoning 单独传入，只进 conversation.md（前端折叠展示），不进 messageLog
    this._appendConversation(taskId, 'assistant', `**${agentName}**\n\n${content}`, {
      agent: agentName,
      reasoning: result.reasoning || '',
      turn_id: turn.turnId,
      from_agent: fromAgent || undefined,
    });

    // 解析模型输出中的行首 @ / @用户 / [持球]（三选一交接）
    const parsed = this._extractMentionsFromReply(content, agentName);
    if (parsed && parsed.error) {
      this._appendConversation(taskId, 'system', `[违规转交] ${parsed.error.message}（已忽略本次转交）`);
      return { ok: true, content };
    }

    // ===== 交接三选一（P1）=====
    // ① 并行轮：多个 agent 独立作答，@ 无路由语义（只提示一次，避免刷屏）
    if (turn.parallelRound && parsed && (parsed.mentions.length || parsed.terminal || parsed.hold)) {
      if (!turn.parallelNotified) {
        turn.parallelNotified = true;
        this._appendConversation(taskId, 'system',
          '[并行模式] 本轮多个 agent 独立作答，@ 无路由语义，已忽略本次交接');
      }
      return { ok: true, content };
    }
    // ② 交还用户：终端目标，链终止（不再 spawn 任何 agent）
    if (parsed && parsed.terminal) {
      this._appendConversation(taskId, 'system',
        `[交还用户] ${agentName} 请求你处理：${parsed.terminal.description}`);
      return { ok: true, content, terminal: true };
    }
    // ③ 持球等待：不进转交链，本轮结束（不自动轮询，等下一条新消息解锁）
    if (parsed && parsed.hold) {
      const holdReason = parsed.hold.reason || '等待外部条件';
      this._appendConversation(taskId, 'system', `[持球] ${agentName} 正在等待：${holdReason}`, { kind: 'hold' });
      CollabLogger.log('hold_ball', {
        task_id: taskId, trace_id: task.trace_id || '', agent: agentName, reason: holdReason,
      });
      return { ok: true, content, holding: true };
    }
    // 球权死锁提示：收了球却让别人等，且没有任何交接动作（不阻断，只提示）
    if (parsed && parsed.mentions.length === 0 && this._looksLikeBallDeadlock(content)) {
      this._appendConversation(taskId, 'system',
        `[提示] ${agentName} 本轮未交接（球权未转移）：做不了请退回上一位，或 @用户 升级`);
    }

    // 并行扇出到被 @ 的 agent（共享 budget / 乒乓计数防爆炸；无 visited 限制）
    const targets = (parsed && parsed.mentions) || [];
    const nextChain = (Array.isArray(chain) && chain.length ? chain : ['用户'])
      .filter(n => n !== agentName)
      .concat(agentName);
    const branches = targets
      .filter(m => hop < maxHops && budget.left > 0)
      .map(m => {
        this._appendConversation(taskId, 'system', `[转交] ${agentName} → ${m.agent}`);
        return this._runAgentWithHandoff(
          task, taskId, m.agent, m.description || '请基于以上对话继续处理。',
          hop + 1, budget, maxHops, turn, {
            fromAgent: agentName,
            triggerContent: content,
            mentionDesc: m.description || '',
            chain: nextChain,
          }
        );
      });

    const settled = await Promise.allSettled(branches);
    const childContents = settled
      .map(r => (r.status === 'fulfilled' && r.value && r.value.ok) ? r.value.content : '')
      .filter(Boolean);

    return { ok: true, content: content + (childContents.length ? '\n\n' + childContents.join('\n\n') : '') };
  },

  /**
   * 带流式推送的执行：把 CLI 增量输出通过事件总线推给前端
   *
   * 事件序列（每个 agent 回答一次触发一组）：
   *   agent:stream:start  { task_id, agent }                      — 前端创建流式气泡
   *   agent:stream:chunk  { task_id, agent, chunk, stream_id }    — 增量文本
   *   agent:stream:end    { task_id, agent, stream_id }           — 该回答流结束
   */
  async _streamedExecute(task, taskId, agentName, conversationHistory) {
    const streamId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    eventBus.emit('agent:stream:start', { task_id: taskId, agent: agentName, stream_id: streamId });

    let buffered = '';
    let lastEmit = 0;
    const onChunk = (chunk) => {
      buffered += chunk;
      // 节流：每 80ms 最多推送一次，避免事件洪泛
      const now = Date.now();
      if (buffered && now - lastEmit >= 80) {
        lastEmit = now;
        eventBus.emit('agent:stream:chunk', { task_id: taskId, agent: agentName, chunk: buffered, stream_id: streamId });
        buffered = '';
      }
    };

    // 思考块到达时立即推送（先于答案正文），前端独立折叠展示
    const onReasoning = (chunk) => {
      if (!chunk) return;
      eventBus.emit('agent:stream:reasoning', {
        task_id: taskId, agent: agentName, stream_id: streamId,
        reasoning: chunk,
      });
    };

    try {
      const result = await agentRuntime.executeTaskWithAgent(task, conversationHistory, agentName, onChunk, onReasoning);
      // 推完剩余缓冲
      if (buffered) {
        eventBus.emit('agent:stream:chunk', { task_id: taskId, agent: agentName, chunk: buffered, stream_id: streamId });
        buffered = '';
      }
      eventBus.emit('agent:stream:end', { task_id: taskId, agent: agentName, stream_id: streamId });
      return result;
    } catch (e) {
      if (buffered) {
        eventBus.emit('agent:stream:chunk', { task_id: taskId, agent: agentName, chunk: buffered, stream_id: streamId });
      }
      eventBus.emit('agent:stream:end', { task_id: taskId, agent: agentName, stream_id: streamId, error: e.message });
      throw e;
    }
  },

  /**
   * 球权死锁启发式：收了球却让别人等、且没有任何交接动作。
   * 只在措辞明确时提示（诊断≠解决），不阻断。
   */
  _looksLikeBallDeadlock(content) {
    const s = String(content || '');
    return /你(先)?等着|你稍等|稍等(一下)?我|稍后(再)?处理|等我(稍后|一下|处理)|我先记下/.test(s);
  }
};
