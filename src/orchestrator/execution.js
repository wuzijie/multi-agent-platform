/**
 * 讨论模式与 Agent 执行方法（从 orchestrator.js 提取，通过 prototype 赋值接入）
 * 方法内的 this 指向 TaskOrchestrator 实例
 */
const { v4: uuidv4 } = require('uuid');
const eventBus = require('../eventbus/bus');
const agentRuntime = require('../agent/runtime');

module.exports = {

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
      if (!draft) {
        const fallbackHost = participants.find(name => name !== hostAgent);
        if (fallbackHost) {
          this._appendConversation(taskId, 'system', `[讨论模式] ${hostAgent} 初始回答失败，改由 ${fallbackHost} 作答`);
          hostAgent = fallbackHost;
          draft = await this._tryAgentCall(task, taskId, openingPrompt, fallbackHost, 2);
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
        finalRound = round;
        this._appendConversation(taskId, 'system', `[讨论模式] 第 ${round}/${maxRounds} 轮讨论开始`);

        // 2a. 评审者逐个评审当前答案
        const reviewResults = [];
        for (const reviewer of reviewers) {
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

      task.progress = Math.min(1.0, (task.progress || 0) + 0.5);
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      eventBus.emit('task:updated', { task_id: taskId, status: task.status, phase: 'discussion_done', duration_ms: Date.now() - startTime });

      return { task, result: { status: 'success', content: draft } };
    } catch (e) {
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
    const conversationHistory = this._readConversationHistory(taskId);
    const savedInstruction = task.instruction;
    task.instruction = instruction;
    try {
      const result = await this._streamedExecute(task, taskId, agentName, conversationHistory);
      if (result.status !== 'success') {
        throw new Error(`${agentName} 执行失败: ${(result.error && result.error.message) || '未知错误'}`);
      }
      return result.content || '';
    } finally {
      task.instruction = savedInstruction;
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
      try {
        const content = await this._callAgentRaw(task, taskId, instruction, agentName);
        if (content && content.trim()) {
          return content;
        }
        lastError = new Error(`${agentName} 返回空内容`);
      } catch (e) {
        lastError = e;
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

    try {
      const result = await agentRuntime.executeTaskWithAgent(task, conversationHistory, agentName, onChunk);
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
  }

  /**
   * 执行指定 Agent 并处理模型间 @ 转交
   *
   * 规则：
   *   1. Agent 回复中包含「@另一个Agent名 + 问题」时，平台把问题转交给被@的Agent
   *   2. 被@的Agent可以继续@第三个Agent（最多 3 跳，防死循环）
   *   3. 模型间@不改变用户绑定的回复Agent
   *
   * @param {string} fromAgent 问题来源（用户或上一个转交的 Agent），用于方向标签
   */
,

  /**
   * 执行指定 Agent 并处理模型间 @ 转交
   *
   * 规则：
   *   1. Agent 回复中包含「@另一个Agent名 + 问题」时，平台把问题转交给被@的Agent
   *   2. 被@的Agent可以继续@第三个Agent（最多 3 跳，防死循环）
   *   3. 模型间@不改变用户绑定的回复Agent
   *
   * @param {string} fromAgent 问题来源（用户或上一个转交的 Agent），用于方向标签
   */
  async _executeAgentWithMentions(task, taskId, userMessage, execAgent, hop, visited, fromAgent) {
    const startTime = Date.now();

    try {
      // 记录提问方向：hop 0 是用户提问（用户→@Agent），hop ≥ 1 是模型间转交（模型A→@模型B）
      if (hop === 0) {
        this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description, { target: execAgent });
      } else {
        this._appendConversation(taskId, 'user', userMessage, { target: execAgent, from: fromAgent });
      }

      // 读取对话历史
      const conversationHistory = this._readConversationHistory(taskId);

      // 更新 task.instruction 为当前问题，确保 Agent 收到正确指令
      // 并注入团队协作说明：允许模型将问题转交给其他智能体
      const savedInstruction = task.instruction;
      const mentionCapability = '\n\n=== 团队协作 ===\n你可以把问题转交给团队中的其他智能体，格式：@智能体名 问题内容（例如：@吉米 请解释一下这个算法）。可用的智能体：克劳德（Claude，通用）、吉米（Kimi，长文本分析）、迪普斯克（DeepSeek，编程实现）、钱文（Qwen，中文写作）。仅当你自己无法可靠回答该问题时才转交，否则请直接回答。';
      task.instruction = (userMessage || task.instruction || task.description) + mentionCapability;

      // 通过指定 Agent 执行（流式：捕获 CLI 增量输出推送到事件总线）
      const result = await this._streamedExecute(task, taskId, execAgent, conversationHistory);

      // 恢复原 instruction
      task.instruction = savedInstruction;

      if (result.status !== 'success') {
        task.status = 'failed';
        task.suspend_reason = result.error ? result.error.message : '执行失败';
        task.updated_at = new Date().toISOString();
        this._saveTask(task);
        this._updateIndex(task);
        return { task, result };
      }

      // 检查回复中是否包含 @另一个Agent 的转交请求（最多 3 跳，防死循环）
      const mention = this._extractMentionFromReply(result.content, execAgent);
      if (mention && hop < 3 && !visited.has(mention.agent)) {
        visited.add(mention.agent);
        // 记录模型A的回复全文 + 转交声明
        const forwardMsg = `**${execAgent}**\n\n${result.content || ''}\n\n[转交] @${mention.agent}：${mention.question}`;
        this._appendConversation(taskId, 'assistant', forwardMsg, { target: mention.agent, from: execAgent });
        eventBus.emit('task:executing', { task_id: taskId, agent: mention.agent, phase: 'mention' });

        // 转交给被@的Agent：附带转交说明，B 可从对话历史中看到A的完整回复
        const forwardPrompt = `问题：${mention.question}\n\n（此问题由 ${execAgent} 转交给你回答。请参考对话历史中 ${execAgent} 的回复内容，直接给出你的回答；只有在确实无法回答时才可再次转交。）`;

        return await this._executeAgentWithMentions(task, taskId, forwardPrompt, mention.agent, hop + 1, visited, execAgent);
      }

      // 最终回复用户，带上执行 Agent 的名称标记
      const contentWithAgent = `**${execAgent}**\n\n` + (result.content || '');
      this._appendConversation(taskId, 'assistant', contentWithAgent, { target: '用户' });

      // 保存输出文件
      if (result.output_files && result.output_files.length > 0) {
        const outputDir = path.join(ROOT, 'tasks', taskId, 'outputs');
        for (const file of result.output_files) {
          const basename = path.basename(file);
          const dest = path.join(outputDir, basename);
          if (fs.existsSync(file) && !fs.existsSync(dest)) {
            fs.copyFileSync(file, dest);
          }
        }
      }

      // 不标记为 completed，保持 executing 状态以支持多轮对话
      task.progress = Math.min(1.0, (task.progress || 0) + 0.5);
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      eventBus.emit('task:updated', { task_id: taskId, status: task.status, duration_ms: Date.now() - startTime });

      return { task, result };
    } catch (e) {
      task.status = 'failed';
      task.suspend_reason = e.message;
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      this._appendConversation(taskId, 'system', `[错误] ${e.message}`);

      eventBus.emit('task:failed', { task_id: taskId, error: e.message });
      throw e;
    }
  }

  /**
   * 从模型回复中提取 @另一个Agent 的转交请求
   *
   * 格式要求：「@Agent名 + 具体问题」，问题至少 4 个字符才触发转交，
   * 避免模型在普通回复中偶然提及 @Agent名 造成误转交。
   *
   * @returns {Object|null} { agent, question } 或 null
   */
,

  /**
   * 从模型回复中提取 @另一个Agent 的转交请求
   *
   * 格式要求：「@Agent名 + 具体问题」，问题至少 4 个字符才触发转交，
   * 避免模型在普通回复中偶然提及 @Agent名 造成误转交。
   *
   * @returns {Object|null} { agent, question } 或 null
   */
  _extractMentionFromReply(content, currentAgent) {
    if (!content) return null;
    const pattern = /@(克劳德|吉米|迪普斯克|钱文)/g;
    let match = pattern.exec(content);
    while (match) {
      if (match[1] !== currentAgent) {
        const afterAt = content.substring(match.index + match[1].length + 1);
        const question = afterAt.replace(/^[：:，,、\s]+/, '').split(/\n/)[0].trim();
        if (question && question.length >= 4) {
          return { agent: match[1], question };
        }
      }
      match = pattern.exec(content);
    }
    return null;
  }
,
};