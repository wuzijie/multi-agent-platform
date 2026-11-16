/**
 * 讨论模式与 Agent 执行方法（从 orchestrator.js 提取，通过 prototype 赋值接入）
 * 方法内的 this 指向 TaskOrchestrator 实例
 */
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const eventBus = require('../eventbus/bus');
const agentRuntime = require('../agent/runtime');
const transcript = require('../prompt/transcript');
const config = require('../utils/config');
const { enabledAgentNames, enabledAgents } = require('../utils/agent-list');
const { parseMentions } = require('../messaging/mention');
const { buildIncrementalContext } = require('../prompt/incremental');
const cursorStore = require('../messaging/cursor-store');
const renderer = require('../prompt/renderer');
const CollabLogger = require('../utils/collab-logger');

const ROOT = path.resolve(__dirname, '..', '..');

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
   * 多模型循环讨论模式（用户一条消息中 @多个Agent 触发）
   *
   * 流程（以模型A、B、C为例）：
   *   1. 模型A（第一个被@的Agent）回答问题
   *   2. 模型B、C 对 A 的回答进行评审、补充（只给意见和判定，不修改答案）
   *   3. 模型A 参考 B、C 的评审意见修改自己的答案 —— 此为完整一轮
   *   4. 重复直至 B、C 都判定「可行」，或达到轮次上限 5 轮
   *
   * @param {Array<string>} participants 参与讨论的 Agent 名单（第一个是回答者A）
   */
  async _executeDiscussionMode(task, taskId, userMessage, participants) {
    let hostAgent = participants[0];
    const reviewers = participants.slice(1);
    const maxRounds = 5;
    const startTime = Date.now();

    try {
      // 用户提问记录：标明所有参与讨论的 Agent
      this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description, { target: participants.join('、') });
      this._appendConversation(taskId, 'system', `[讨论模式] ${participants.join('、')} 协作讨论 | 回答者: ${hostAgent} | 评审者: ${reviewers.join('、')} | 轮次上限 ${maxRounds}`);

      // Step 1: 回答者A给出初始回答（失败自动重试；仍失败则换参与者中第一位可用 Agent 作答）
      eventBus.emit('task:executing', { task_id: taskId, agent: hostAgent, phase: 'discussion_opening' });
      const openingPrompt = `${userMessage}\n\n（你负责回答以上问题。稍后会有其他智能体评审你的答案，你需参考评审意见持续修改，直到评审全部通过或达到轮次上限。）`;
      let draft = await this._tryAgentCall(task, taskId, openingPrompt, hostAgent, 2);
      if (this._isCancelled(taskId)) return this._finishStoppedTurn(task, taskId);
      if (!draft) {
        const fallbackHost = participants.find(name => name !== hostAgent);
        if (fallbackHost) {
          this._appendConversation(taskId, 'system', `[讨论模式] ${hostAgent} 初始回答失败，改由 ${fallbackHost} 作答`);
          hostAgent = fallbackHost;
          draft = await this._tryAgentCall(task, taskId, openingPrompt, fallbackHost, 2);
          if (this._isCancelled(taskId)) return this._finishStoppedTurn(task, taskId);
        }
      }
      if (!draft) {
        throw new Error('所有参与讨论的 Agent 均无法给出初始回答，讨论无法进行');
      }
      this._appendConversation(taskId, 'assistant', `**${hostAgent}** 初始回答:\n\n${draft}`, { target: reviewers.join('、') });

      // Step 2-N: 讨论轮次（最多 maxRounds 轮）
      //   每轮：评审者逐个评审（判定+意见+补充）→ 回答者参考意见修订答案
      let allPassed = false;
      let finalRound = 0;
      for (let round = 1; round <= maxRounds; round++) {
        // 每轮开始前检查：用户已停止则不再推进
        if (this._isCancelled(taskId)) return this._finishStoppedTurn(task, taskId);
        finalRound = round;
        this._appendConversation(taskId, 'system', `[讨论模式] 第 ${round}/${maxRounds} 轮讨论开始`);

        // 2a. 评审者逐个评审当前答案
        const reviewResults = [];
        for (const reviewer of reviewers) {
          if (this._isCancelled(taskId)) return this._finishStoppedTurn(task, taskId);
          eventBus.emit('task:executing', { task_id: taskId, agent: reviewer, phase: `discussion_round_${round}` });
          const angle = this._agentAngle(reviewer);
          const reviewPrompt = [
            `原始问题：${userMessage}`,
            ``,
            `请评审以下答案（来自 ${hostAgent}）：\n\n${draft}`,
            ``,
            `请站在你的专长角度（${angle}）进行评审，按以下格式回复：`,
            ``,
            `结论：可行 或 需修改`,
            `意见：指出遗漏的关键点、事实错误或逻辑问题`,
            `补充：你认为缺失但重要的内容`,
            ``,
            `注意：你只负责评审，不要直接修改答案；修改由 ${hostAgent} 完成。`,
          ].join('\n');
          const reviewText = await this._tryAgentCall(task, taskId, reviewPrompt, reviewer, 2);
          if (this._isCancelled(taskId)) return this._finishStoppedTurn(task, taskId);
          if (reviewText) {
            const verdict = this._parseReviewVerdict(reviewText);
            reviewResults.push({ reviewer, verdict, text: reviewText });
            this._appendConversation(taskId, 'assistant',
              `**${reviewer}** 评审意见（第 ${round} 轮）[${verdict === 'pass' ? '✓ 可行' : '✗ 需修改'}]:\n\n${reviewText}`, { target: hostAgent });
          } else {
            // 评审者失败：跳过，视为「需修改」以触发修订（不阻塞流程）
            reviewResults.push({ reviewer, verdict: 'revise', text: `${reviewer} 本轮评审失败，意见缺失` });
            this._appendConversation(taskId, 'system',
              `[讨论模式] ${reviewer} 第 ${round} 轮评审失败（已重试 1 次），跳过该评审者，本轮视为「需修改」`);
          }
        }

        // 2b. 判定：所有评审者都「可行」则讨论结束
        allPassed = reviewResults.length > 0 && reviewResults.every(r => r.verdict === 'pass');
        if (allPassed) {
          this._appendConversation(taskId, 'system', `[讨论模式] 第 ${round} 轮：所有评审者均判定「可行」，讨论结束`);
          break;
        }

        // 2c. 回答者A参考评审意见修订答案
        if (round < maxRounds) {
          if (this._isCancelled(taskId)) return this._finishStoppedTurn(task, taskId);
          eventBus.emit('task:executing', { task_id: taskId, agent: hostAgent, phase: `discussion_revise_${round}` });
          const reviewSummary = reviewResults.map(r => `【${r.reviewer} 的意见】\n${r.text}`).join('\n\n---\n\n');
          const revisePrompt = [
            `原始问题：${userMessage}`,
            ``,
            `你上一版答案：\n\n${draft}`,
            ``,
            `评审者们给出的意见：\n\n${reviewSummary}`,
            ``,
            `请参考以上评审意见修改你的答案，输出完整的修订版答案全文（直接输出答案内容，不要附带说明）。`,
          ].join('\n');
          const revised = await this._tryAgentCall(task, taskId, revisePrompt, hostAgent, 2);
          if (this._isCancelled(taskId)) return this._finishStoppedTurn(task, taskId);
          if (revised) {
            draft = revised;
            this._appendConversation(taskId, 'assistant', `**${hostAgent}** 修订版答案（第 ${round} 轮）:\n\n${revised}`, { target: reviewers.join('、') });
          } else {
            this._appendConversation(taskId, 'system', `[讨论模式] ${hostAgent} 第 ${round} 轮修订失败（已重试 1 次），继续使用当前版本`);
          }
        }
      }

      // Step 3: 输出最终答案（A 的最后一版）
      if (!allPassed) {
        this._appendConversation(taskId, 'system', `[讨论模式] 已达轮次上限 ${maxRounds} 轮，返回 ${hostAgent} 的最后一版答案`);
      }
      this._appendConversation(taskId, 'assistant', `**${hostAgent}** 最终答案（第 ${finalRound} 轮后${allPassed ? '，评审通过' : ''}）:\n\n${draft}`, { target: '用户' });

      // 讨论模式的中间阶段不写入转录，这里只记录「用户问题 + 最终答案」，
      // 供下一轮对话延续上下文。
      this._recordTurnToTranscript(taskId, userMessage, hostAgent, draft);

      task.progress = Math.min(1.0, (task.progress || 0) + 0.5);
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      eventBus.emit('task:updated', { task_id: taskId, status: task.status, phase: 'discussion_done', duration_ms: Date.now() - startTime });

      return { task, result: { status: 'success', content: draft } };
    } catch (e) {
      // 用户停止本轮导致的异常：优雅收尾，不把任务判为失败
      if (this._isCancelled(taskId)) return this._finishStoppedTurn(task, taskId);
      task.status = 'failed';
      task.suspend_reason = e.message;
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      this._appendConversation(taskId, 'system', `[讨论中断] ${e.message}`);
      eventBus.emit('task:failed', { task_id: taskId, error: e.message });
      throw e;
    }
  }

  /**
   * 解析评审者的结论
   *
   * 支持「结论：可行」/「结论: 需修改」等格式；
   * 无法识别时按正文关键词判断，仍无法判断则默认「需修改」（触发修订，更稳妥）。
   *
   * @param {string} reviewText 评审者回复全文
   * @returns {'pass'|'revise'} 可行 / 需修改
   */
,

  /**
   * 解析评审者的结论
   *
   * 支持「结论：可行」/「结论: 需修改」等格式；
   * 无法识别时按正文关键词判断，仍无法判断则默认「需修改」（触发修订，更稳妥）。
   *
   * @param {string} reviewText 评审者回复全文
   * @returns {'pass'|'revise'} 可行 / 需修改
   */
  _parseReviewVerdict(reviewText) {
    if (!reviewText) return 'revise';
    // 优先匹配「结论」行
    const conclusionMatch = reviewText.match(/结论[：:]\s*(可行|通过|合格|可接受|无需修改|需修改|需补充|不通过|不可行|存在问题)/);
    if (conclusionMatch) {
      const word = conclusionMatch[1];
      if (['可行', '通过', '合格', '可接受', '无需修改'].includes(word)) return 'pass';
      return 'revise';
    }
    // 回退：正文关键词判断
    const text = reviewText.slice(0, 500);
    if (/认为可行|判定.*可行|没有(明显)?问题|无(明显)?问题|基本完善|无需修改|可以通过/.test(text)) return 'pass';
    if (/需修改|需要修改|需补充|需要补充|不通过|不可行|存在问题|有(以下|如下|几处|一些)?(问题|错误|遗漏)/.test(text)) return 'revise';
    // 无法判断：默认需修改
    return 'revise';
  }

  /**
   * 直接调用指定 Agent（不注入@转交能力，不做@路由）
   * 讨论模式的内部调用原语
   */
,

  /**
   * 直接调用指定 Agent（不注入@转交能力，不做@路由）
   * 讨论模式的内部调用原语
   */
  async _callAgentRaw(task, taskId, instruction, agentName) {
    const savedInstruction = task.instruction;
    const savedDisableTools = task.disableTools;
    // 讨论/辩论等内部调用：读取历史作为稳定前缀，但**不写入**转录
    // （否则阶段性的评审/修订文本会污染下一轮聊天历史）。
    task.history_segments = transcript.loadSegments(taskId);
    task.chat_mode = true;
    task.record_transcript = false;
    task.instruction = instruction;
    // 内部调用（讨论各阶段）禁用工具循环，防止递归调用工具导致流式气泡嵌套乱序
    task.disableTools = true;
    // 动态上下文：触发者标记为协作流程（runtime 通用增量上下文自动组装）
    task.trigger_from = '协作流程';
    task.trigger_content = instruction;
    task.mention_desc = '';
    try {
      const result = await this._streamedExecute(task, taskId, agentName, []);
      if (result.status !== 'success') {
        throw new Error(`${agentName} 执行失败: ${(result.error && result.error.message) || '未知错误'}`);
      }
      return result.content || '';
    } finally {
      task.instruction = savedInstruction;
      task.disableTools = savedDisableTools;
      delete task.trigger_from;
      delete task.trigger_content;
      delete task.mention_desc;
    }
  }

  /**
   * 带重试的 Agent 调用：失败自动重试，全部失败返回 null（不抛异常）
   *
   * @param {Object} task - 任务对象
   * @param {string} taskId - 任务 ID
   * @param {string} instruction - 指令
   * @param {string} agentName - Agent 名称
   * @param {number} maxAttempts - 最大尝试次数（默认 2：初次 + 1 次重试）
   * @returns {Promise<string|null>} 成功返回内容，失败返回 null
   */
,

  /**
   * 带重试的 Agent 调用：失败自动重试，全部失败返回 null（不抛异常）
   *
   * @param {Object} task - 任务对象
   * @param {string} taskId - 任务 ID
   * @param {string} instruction - 指令
   * @param {string} agentName - Agent 名称
   * @param {number} maxAttempts - 最大尝试次数（默认 2：初次 + 1 次重试）
   * @returns {Promise<string|null>} 成功返回内容，失败返回 null
   */
  async _tryAgentCall(task, taskId, instruction, agentName, maxAttempts = 2) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 用户已停止本轮：不再发起新调用，也不再重试
      if (this._isCancelled(taskId)) return null;
      try {
        const content = await this._callAgentRaw(task, taskId, instruction, agentName);
        if (content && content.trim()) {
          return content;
        }
        lastError = new Error(`${agentName} 返回空内容`);
      } catch (e) {
        lastError = e;
        // 取消导致的失败不重试（否则会重新拉起模型）
        if (this._isCancelled(taskId)) break;
        if (attempt < maxAttempts) {
          this._appendConversation(taskId, 'system', `[讨论模式] ${agentName} 调用失败（第 ${attempt} 次）：${e.message}，即将重试...`);
        }
      }
    }
    if (lastError) {
      this._appendConversation(taskId, 'system', `[讨论模式] ${agentName} 重试 ${maxAttempts} 次后仍失败：${lastError.message}`);
    }
    return null;
  }

  /**
   * 带流式推送的执行：把 CLI 增量输出通过事件总线推给前端
   *
   * 事件序列（每个 agent 回答一次触发一组）：
   *   agent:stream:start  { task_id, agent }                      — 前端创建流式气泡
   *   agent:stream:chunk  { task_id, agent, chunk, stream_id }    — 增量文本
   *   agent:stream:end    { task_id, agent, stream_id }           — 该回答流结束
   */
,

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
  }

  /**
   * Agent 的评审专长角度（用于讨论模式中给不同 Agent 分配视角）
   */
,

  /**
   * Agent 的评审专长角度（用于讨论模式中给不同 Agent 分配视角）
   */
  _agentAngle(agentName) {
    const angles = {
      '克劳德': '逻辑严谨、代码规范、长文本处理',
      '吉米': '大容量文本处理、信息提炼精准',
      '迪普斯克': '技术深度、专业性、纠错能力',
      '钱文': '场景适配、中文表达优化、兼容性',
    };
    return angles[agentName] || '多角度综合审视';
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
    const maxSpawns = Number(cfg.max_spawns_per_turn) || 6;
    const maxHops = Number(cfg.max_hops) || 6;
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
    };

    this._appendConversation(taskId, 'user', displayMessage, {
      target: jobs.map(j => j.agent).join('、'),
      turn_id: turnCtx.turnId,
    });

    const budget = { left: maxSpawns };
    // 不再使用 visited 集合：同一 agent 可被多次召唤，由乒乓计数 + 召唤上限治理
    const runOne = (job, hop) => this._runAgentWithHandoff(
      task, taskId, job.agent, job.instruction, hop, budget, maxHops, turnCtx, null
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
    // 落库时记录 agent，游标才能“排除自身输出”
    // reasoning 单独传入，只进 conversation.md（前端折叠展示），不进 messageLog
    this._appendConversation(taskId, 'assistant', `**${agentName}**\n\n${content}`, {
      agent: agentName,
      reasoning: result.reasoning || '',
      turn_id: turn.turnId,
      from_agent: fromAgent || undefined,
    });

    // 解析模型输出中的行首 @（最多 2 个，不能 @ 自己，必须带任务描述）
    const parsed = this._extractMentionsFromReply(content, agentName);
    if (parsed && parsed.error) {
      this._appendConversation(taskId, 'system', `[违规转交] ${parsed.error.message}（已忽略本次转交）`);
      return { ok: true, content };
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
  }
,
  /**
   * 把一轮「用户问题 + 最终答案」写入对话转录。
   * 仅用于不走聊天主路径的模式（讨论 / 辩论 / 事件驱动协作），
   * 保证下一次对话仍能看到本轮结论。
   */
  _recordTurnToTranscript(taskId, userMessage, agentName, content) {
    try {
      transcript.recordTurn(taskId, userMessage, agentName, content);
    } catch (e) { /* 转录写入失败不影响主流程 */ }
  }
};