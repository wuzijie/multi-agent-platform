const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const agentRuntime = require('../agent/runtime');
const eventBus = require('../eventbus/bus');
const config = require('../utils/config');
const blackboard = require('../blackboard/blackboard');
const scheduler = require('../engine/scheduler');
const { EVENTS, TASK_STATUS, TASK_TYPES, genSubTaskId } = require('../engine/events');

const ROOT = path.resolve(__dirname, '..', '..');

// 事件驱动协作：任务类型 → 中文标签
const COLLAB_TYPE_LABEL = {
  PLAN_TASK: '规划',
  CODE_TASK: '执行',
  REVIEW_TASK: '评审',
  SUMMARY_TASK: '汇总',
  DEBUG_TASK: '调试',
};

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

  /**
   * 判别任务复杂度（通过 Claude 判别）
   */
  async assessComplexity(taskId, opts = {}) {
    const task = this._loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // 如果用户明确传了 multi_agent，跳过 Claude 评估，直接设置
    if (opts.multi_agent === true || opts.multi_agent === false) {
      const isComplex = opts.multi_agent;
      task.complex_flag = isComplex;
      task.difficulty = isComplex ? 'complex' : 'simple';
      task.status = isComplex ? 'executing' : 'executing';

      this._saveTask(task);
      this._updateIndex(task);

      const label = isComplex ? '多Agent协作模式' : '单Agent模式';
      this._appendConversation(taskId, 'system', `[模式选择] ${label}`);

      eventBus.emit('task:assessed', { task_id: taskId, complex_flag: isComplex });
      return task;
    }

    // 未传 multi_agent，走原有的 Claude 自动评估逻辑
    task.status = 'assessing';
    this._saveTask(task);
    this._updateIndex(task);

    try {
      const agent = agentRuntime.agents.get('克劳德');
      if (!agent || !agent.adapter) {
        // 无法连接 Claude，默认标记为简单
        task.complex_flag = false;
        task.difficulty = 'simple';
        task.status = 'executing';
        this._saveTask(task);
        this._updateIndex(task);
        return task;
      }

      const input = {
        task_id: taskId,
        role: 'executor',
        context: '你是一个任务复杂度评估器。请判断以下任务属于"简单"还是"复杂"。',
        instruction: `请评估以下任务的复杂度，仅返回 {"complex": true} 或 {"complex": false}，并简要说明理由。

任务名称: ${task.name}
任务描述: ${task.description}
任务类型: ${task.task_type}
优先级: ${task.priority}

判断标准:
- 简单任务: 可以直接由一个 Agent 独立完成，不涉及多步骤协调、复杂决策或多模型协作
- 复杂任务: 需要多步骤分解、多视角评审、代码/方案迭代优化、或涉及复杂架构设计`,
        max_tokens: 512,
      };

      const result = await agent.adapter.execute(input);

      // 解析 Claude 的回复
      let isComplex = false;
      let reason = '';
      try {
        const content = result.content || '';
        const jsonMatch = content.match(/\{[^}]*"complex"[^}]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          isComplex = !!parsed.complex;
          reason = parsed.reason || '';
        }
        // 如果找不到 JSON，检查文字中是否包含 "复杂"
        if (!jsonMatch && content.includes('复杂')) {
          isComplex = true;
        }
      } catch (e) {
        // 解析失败，默认认为简单
        isComplex = false;
      }

      task.complex_flag = isComplex;
      task.difficulty = isComplex ? 'complex' : 'simple';
      task.status = isComplex ? 'suspended' : 'executing';

      if (isComplex) {
        task.suspend_reason = '复杂任务，完整多Agent协作将于二期上线。当前已标记为复杂任务，暂不执行协同流程。';
      }

      this._saveTask(task);
      this._updateIndex(task);

      // 追加对话记录
      this._appendConversation(taskId, 'system', `[复杂度评估] ${isComplex ? '复杂任务' : '简单任务'} - ${reason}`);

      eventBus.emit('task:assessed', { task_id: taskId, complex_flag: isComplex });
      return task;
    } catch (e) {
      task.complex_flag = false;
      task.difficulty = 'simple';
      task.status = 'executing';
      this._saveTask(task);
      this._updateIndex(task);
      return task;
    }
  }

  /**
   * 执行简单任务
   */
  async executeSimpleTask(taskId, userMessage, opts = {}) {
    const task = this._loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // 如果用户通过 @mention 指定了 Agent，使用该 Agent（并持久化，后续对话默认由该 Agent 回复）
    if (opts.mentioned_agent && opts.mentioned_agent !== task.executor_agent) {
      task.executor_agent = opts.mentioned_agent;
      this._appendConversation(taskId, 'system', `[回复Agent] 后续对话由 ${opts.mentioned_agent} 回复`);
    }
    const execAgent = task.executor_agent || '克劳德';

    task.status = 'executing';
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);

    eventBus.emit('task:executing', { task_id: taskId, agent: execAgent });

    // 事件驱动协作模式（消息总线 + 黑板 + DAG 编排）
    if (opts.collab_mode === 'event-driven') {
      return await this._executeEventDrivenCollaboration(task, taskId, userMessage, opts);
    }

    // 多模型讨论模式：一条消息中 @了 2 个及以上 Agent
    if (opts.discussion_agents && Array.isArray(opts.discussion_agents)) {
      const valid = opts.discussion_agents.filter(n => ['克劳德', '吉米', '迪普斯克', '钱文'].includes(n));
      const unique = [...new Set(valid)];
      if (unique.length >= 2) {
        return await this._executeDiscussionMode(task, taskId, userMessage, unique);
      }
    }

    return await this._executeAgentWithMentions(task, taskId, userMessage, execAgent, 0, new Set([execAgent]), null);
  }

  /**
   * 初始化事件驱动引擎（统一调度器 + 黑板 + 流式 executor）
   * 首次使用事件驱动协作模式时调用一次
   */
  _ensureEventDrivenEngine() {
    if (scheduler.ready) return;

    const self = this;

    // 任务拆解完成 → 写入对话，展示主agent（克劳德）的拆解结果
    eventBus.on('collab:planned', (e) => {
      const d = (e && e.data !== undefined) ? e.data : e;
      if (!d || !d.task_id) return;
      const lines = (d.sub_tasks || []).map((s, i) => `${i + 1}. [${COLLAB_TYPE_LABEL[s.type] || s.type || ''}] ${s.description || ''}`.trim());
      if (lines.length) {
        const content = `**克劳德** 任务拆解\n\n已拆解为 ${lines.length} 个子任务：\n${lines.join('\n')}`;
        self._appendConversation(d.task_id, 'assistant', content);
      }
    });

    // 子任务执行完成 → 写入对话，逐条展示各模型的输出
    eventBus.on('collab:subtask:done', (e) => {
      const d = (e && e.data !== undefined) ? e.data : e;
      if (!d || !d.task_id) return;
      const typeName = COLLAB_TYPE_LABEL[d.type] || d.type || '子任务';
      for (const o of (d.agents_outputs || [])) {
        self._appendConversation(d.task_id, 'assistant', `**${o.agent}** 完成「${typeName}」\n\n${o.content || ''}`);
      }
      for (const err of (d.errors || [])) {
        self._appendConversation(d.task_id, 'assistant', `**${err.agent}**「${typeName}」失败\n\n${err.error || ''}`);
      }
    });

    scheduler.init({
      eventBus,
      agentRuntime,
      plannerMode: 'llm', // 由主agent（克劳德）拆解任务并分配子任务
      agentsPerTask: 1,
      executor: {
        plan: (userQuery, traceId) => this._planTask(userQuery, traceId),
        async run(subTask, agentName, onChunk) {
          const externalTaskId = subTask.external_task_id || subTask.task_id;
          const streamId = uuidv4();
          // 流式事件：关联到前端当前任务
          eventBus.emit('agent:stream:start', { task_id: externalTaskId, agent: agentName, stream_id: streamId });
          try {
            const result = await agentRuntime.executeTaskWithAgent(subTask, [], agentName, (chunk) => {
              if (typeof onChunk === 'function') onChunk(chunk);
              eventBus.emit('agent:stream:chunk', { task_id: externalTaskId, agent: agentName, chunk, stream_id: streamId });
            });
            eventBus.emit('agent:stream:end', { task_id: externalTaskId, agent: agentName, stream_id: streamId });
            // 适配器失败不 throw，需显式检查 → 抛给调度器走 SUB_TASK_FAIL 重试
            if (result && (result.status === 'failed' || result.error)) {
              const errMsg = (result.error && result.error.message) || result.status || 'Agent 执行失败';
              throw new Error(errMsg);
            }
            return result;
          } catch (e) {
            eventBus.emit('agent:stream:end', { task_id: externalTaskId, agent: agentName, stream_id: streamId, error: e.message });
            throw e;
          }
        },
      },
    });
  }

  /**
   * 由主 agent（克劳德）拆解任务，生成子任务 DAG 并指定每个子任务的执行模型
   * 解析失败/调用失败时回退内置默认 DAG
   */
  async _planTask(userQuery, traceId) {
    const planPrompt = [
      '你是一个多智能体协作平台中的主智能体（克劳德），负责把用户的请求拆解为可执行的子任务 DAG，并为每个子任务指定执行模型。',
      '',
      '可用模型：',
      '- 克劳德：通用能力、复杂架构、代码规范',
      '- 吉米：长文本处理、文档分析、信息提炼',
      '- 迪普斯克：编程实现、算法、纠错调试',
      '- 钱文：快速开发、场景适配、中文优化',
      '',
      '要求：',
      '1. 把请求拆解为 2-5 个子任务，形成有依赖关系的 DAG（第一个子任务无依赖）',
      '2. 为每个子任务选择最合适的执行模型（可分配给自己或其他模型）',
      '3. 每个子任务只指定一个执行模型',
      '',
      '输出纯 JSON 数组，不要任何其他文字或 markdown 围栏，格式：',
      '[{"type":"PLAN_TASK|CODE_TASK|REVIEW_TASK|SUMMARY_TASK|DEBUG_TASK","instruction":"子任务执行指令","deps":[依赖的子任务序号，如0],"agent":"克劳德|吉米|迪普斯克|钱文"}]',
      '',
      '用户请求：' + userQuery,
    ].join('\n');

    try {
      // 流式展示主agent拆解过程（关联外部任务，前端显示克劳德流式气泡）
      const externalTaskId = blackboard.hget(`blackboard:task:${traceId}:main`, 'task_id') || traceId;
      const streamId = uuidv4();
      eventBus.emit('agent:stream:start', { task_id: externalTaskId, agent: '克劳德', stream_id: streamId });
      const result = await agentRuntime.executeTaskWithAgent({
        task_id: traceId,
        role: 'executor',
        context: '任务规划拆解',
        instruction: planPrompt,
        input_files: [],
      }, [], '克劳德', (chunk) => {
        eventBus.emit('agent:stream:chunk', { task_id: externalTaskId, agent: '克劳德', chunk, stream_id: streamId });
      });
      eventBus.emit('agent:stream:end', { task_id: externalTaskId, agent: '克劳德', stream_id: streamId });

      const content = (result && result.content) || '';
      const parsed = this._parsePlanOutput(content, userQuery, traceId);
      if (parsed) return parsed;
      console.warn('[EventDriven] 克劳德规划输出无法解析，回退默认 DAG');
    } catch (e) {
      console.warn('[EventDriven] 克劳德规划失败，回退默认 DAG:', e.message);
    }
    return scheduler.defaultDag(userQuery, traceId);
  }

  /**
   * 解析主 agent 规划输出（纯 JSON 数组），失败返回 null
   */
  _parsePlanOutput(content, userQuery, traceId) {
    if (!content || !content.trim()) return null;
    let text = content.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
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

    const agentAlias = { claude: '克劳德', kimi: '吉米', deepseek: '迪普斯克', qwen: '钱文' };
    const nodes = arr.map((item, seq) => {
      const type = item.type || TASK_TYPES.CODE;
      const deps = Array.isArray(item.deps) ? item.deps.map(d => Number(d)) : [];
      const depsIds = deps
        .filter(d => Number.isInteger(d) && d >= 0 && d < arr.length && d !== seq)
        .map(d => genSubTaskId(traceId, d));
      let agent = item.agent || '';
      agent = agentAlias[String(agent).toLowerCase()] || agent;
      return {
        seq,
        id: genSubTaskId(traceId, seq),
        type,
        instruction: item.instruction || item.task || userQuery,
        deps: depsIds,
        role: type === TASK_TYPES.REVIEW ? 'reviewer' : type === TASK_TYPES.SUMMARY ? 'guardian' : 'executor',
        agent: agent || null,
      };
    });
    return nodes;
  }

  /**
   * 事件驱动协作模式（消息总线 + 黑板 + DAG 编排）
   *
   * 按《消息总线+Redis黑板 多Agent协作生产级方案》：
   * 调度器拆解 DAG（规划→执行→评审→汇总），按依赖事件驱动调度，
   * 子任务由能力画像匹配到各 Agent，状态全部落黑板，结果汇总回写。
   */
  async _executeEventDrivenCollaboration(task, taskId, userMessage, opts = {}) {
    this._ensureEventDrivenEngine();

    try {
      // 用户消息补写进对话（其他模式都会记录用户提问，事件驱动模式此前遗漏）
      this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description, { target: task.executor_agent || '克劳德' });

      const result = await scheduler.createTask(userMessage, {
        taskId,
        executorAgent: task.executor_agent || '克劳德',
      });
      // result: { trace_id, final_result, status }
      const content = (result && result.final_result) || '';
      const succeeded = result && result.status === TASK_STATUS.SUCCESS;
      const traceId = result && result.trace_id;

      this._appendConversation(taskId, 'assistant', `**事件驱动协作结果**\n\n${content}`);

      // 多轮对话：保持任务 executing（不结束），记录最新协作 trace 供右侧任务面板查询
      task.status = 'executing';
      task.result = content;
      task.collab_trace_id = traceId || task.collab_trace_id;
      task.updated_at = new Date().toISOString();
      if (!succeeded) task.suspend_reason = '本轮协作存在未完成任务，可继续输入或结束对话';
      else delete task.suspend_reason;
      this._saveTask(task);
      this._updateIndex(task);
      eventBus.emit('task:executing', { task_id: taskId, phase: 'collab-done' });

      if (!succeeded) {
        this._appendConversation(taskId, 'system', '[事件驱动协作] 本轮存在失败子任务，可继续输入新问题或结束对话');
      }

      return { task, result: content };
    } catch (e) {
      task.status = 'executing';
      task.updated_at = new Date().toISOString();
      task.suspend_reason = e.message;
      this._saveTask(task);
      this._updateIndex(task);
      eventBus.emit('task:failed', { task_id: taskId, error: e.message });
      return { task, result: '', error: e.message };
    }
  }

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

  /**
   * 执行复杂任务 — 多Agent协作流程
   *
   * 流程（二期简化版）：
   *   1. 任务画像生成   — 分析任务需求，匹配最佳执行者和评审者
   *   2. Executor 执行   — 由匹配的执行者 Agent 产出结果
   *   3. Reviewer 并行评审 — 2 个不同模型 Agent 独立评审
   *   4. 冲突裁决        — 评审意见冲突时少数服从多数，票数均等克劳德裁决
   *   5. 迭代修正        — 评审不通过时退回重试，最多 3 轮
   */
  async executeComplexTask(taskId, userMessage) {
    const task = this._loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    task.status = 'executing';
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);

    // ===== Step 1: 任务画像生成 =====
    eventBus.emit('task:executing', { task_id: taskId, agent: '多Agent协作', phase: 'profiling' });
    this._appendConversation(taskId, 'system', '[多Agent协作] 开始任务画像分析...');

    const profile = this._generateTaskProfile(task);
    task.executor_agent = profile.executor;
    task.reviewer_agents = profile.reviewers;
    this._saveTask(task);
    this._updateIndex(task);

    this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description, { target: profile.executor });

    this._appendConversation(taskId, 'system',
      `[任务画像] 执行者: ${profile.executor} | 评审者: ${profile.reviewers.join(', ')} | 能力需求: ${profile.capabilities.join(', ')}`);

    // ===== Step 2: Executor 执行 =====
    this._appendConversation(taskId, 'system', `[执行阶段] ${profile.executor} 开始执行任务...`);
    eventBus.emit('task:executing', { task_id: taskId, agent: profile.executor, phase: 'execution' });

    const history = this._readConversationHistory(taskId);
    let execResult;
    try {
      execResult = await this._streamedExecute(task, taskId, profile.executor, history);
    } catch (e) {
      task.status = 'failed';
      task.suspend_reason = `执行失败: ${e.message}`;
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      this._appendConversation(taskId, 'system', `[错误] 执行失败: ${e.message}`);
      throw e;
    }

    this._appendConversation(taskId, 'assistant', `**${profile.executor}** 的产出:

${execResult.content || ''}`, { target: profile.reviewers.join('、') });

    if (execResult.status !== 'success') {
      task.status = 'failed';
      task.suspend_reason = execResult.error ? execResult.error.message : '执行失败';
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);
      return { task, result: execResult };
    }

    // ===== Step 3: 多 Reviewer 并行评审 =====
    this._appendConversation(taskId, 'system',
      `[评审阶段] 并行评审中，评审者: ${profile.reviewers.join(', ')}...`);
    eventBus.emit('task:executing', { task_id: taskId, agent: '多Agent协作', phase: 'review' });

    const reviews = await this._parallelReview(task, execResult.content, profile.reviewers);

    // 记录各评审意见
    for (const review of reviews) {
      const passedLabel = review.verdict === 'pass' ? '✓ 通过' : review.verdict === 'reject' ? '✗ 驳回' : '⚠ 建议修改';
      this._appendConversation(taskId, 'assistant',
        `**${review.reviewer}** 评审意见 [${passedLabel}]:

${review.content || review.reason || '（无详细意见）'}`, { target: profile.executor });

      // 保存评审文件
      const reviewPath = path.join(ROOT, 'tasks', taskId, 'reviews', `${review.reviewer}.md`);
      fs.writeFileSync(reviewPath, `# ${review.reviewer} 评审意见

**时间**: ${new Date().toISOString()}
**结论**: ${passedLabel}

## 意见

${review.content || ''}
`);
    }

    // ===== Step 4: 冲突裁决 =====
    const verdict = this._adjudicateReviews(reviews);
    this._appendConversation(taskId, 'system',
      `[裁决结果] ${verdict.action === 'accept' ? '全部通过，接受产出' : verdict.action === 'revise' ? '存在分歧，需要修正' : '评审驳回，需重新执行'} — ${verdict.reason}`);

    // ===== Step 5: 迭代修正 =====
    if (verdict.action !== 'accept') {
      if (task.revision_round >= task.max_revision_rounds) {
        task.status = 'suspended';
        task.suspend_reason = `已迭代 ${task.revision_round} 轮，仍未通过评审，请人工介入`;
        task.updated_at = new Date().toISOString();
        this._saveTask(task);
        this._updateIndex(task);
        this._appendConversation(taskId, 'system', `[挂起] 已迭代 ${task.revision_round} 轮未通过评审，任务挂起`);
        return { task, result: execResult };
      }

      task.revision_round++;
      task.updated_at = new Date().toISOString();
      this._saveTask(task);
      this._updateIndex(task);

      // 汇总评审意见作为修改指引
      const revisionGuidance = verdict.revisionNotes || reviews.filter(r => r.verdict !== 'pass').map(r => r.content).join('\n\n');
      this._appendConversation(taskId, 'system',
        `[修正阶段] 第 ${task.revision_round}/${task.max_revision_rounds} 轮修正，修改指引:

${revisionGuidance}`);

      const revisedHistory = this._readConversationHistory(taskId);
      const revisedInput = {
        ...task,
        instruction: `以下是第 ${task.revision_round} 轮修正。请根据以下评审意见修改你的产出：

${revisionGuidance}

=== 原始产出 ===
${execResult.content}`,
      };

      const revisedResult = await this._streamedExecute(revisedInput, taskId, profile.executor, revisedHistory);

      this._appendConversation(taskId, 'assistant', `**${profile.executor}** 修正后产出:

${revisedResult.content || ''}`, { target: profile.reviewers.join('、') });

      execResult = revisedResult;
    }

    task.progress = Math.min(1.0, 0.5 + task.revision_round * 0.2);
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);

    this._appendConversation(taskId, 'system', '[多Agent协作] 协作流程完成');
    eventBus.emit('task:updated', { task_id: taskId, status: task.status });

    return { task, result: execResult };
  }

  /**
   * 生成任务画像 — 基于能力标签匹配
   */
  _generateTaskProfile(task) {
    const agentsConfig = config.agents;
    const instruction = (task.instruction || '') + ' ' + (task.description || '');

    // 能力关键词映射
    const capabilityKeywords = {
      'code': ['代码', '开发', '编程', '函数', '算法', 'bug', '修复', '实现', '写', '脚本', 'Python', 'Java', 'JS', 'TypeScript', 'API', '接口'],
      'architecture': ['架构', '设计', '方案', '系统', '重构', '模块'],
      'review': ['评审', '审查', '检查', 'review'],
      'text': ['文档', '报告', '文案', '说明', '文章', '写'],
      'analysis': ['分析', '调研', '研究', '评估'],
      'refinement': ['优化', '改进', '润色', '完善'],
    };

    // 统计各能力关键词命中次数
    const capabilityScores = {};
    for (const [cap, keywords] of Object.entries(capabilityKeywords)) {
      let score = 0;
      for (const kw of keywords) {
        if (instruction.includes(kw)) score++;
      }
      if (score > 0) capabilityScores[cap] = score;
    }

    // 默认需要的能力
    const requiredCaps = Object.keys(capabilityScores).length > 0
      ? Object.keys(capabilityScores).sort((a, b) => capabilityScores[b] - capabilityScores[a])
      : ['code', 'review'];

    // 为每个 Agent 计算匹配分数
    // 建立 Agent capability 到 keyword-capability 的显式映射
    const capToCapMap = {
      'complex_code': 'code', 'algorithm': 'code', 'lightweight_dev': 'code',
      'architecture': 'architecture',
      'code_review': 'review', 'bug_detection': 'review',
      'text_refinement': 'text', 'long_text': 'text', 'documentation': 'text',
      'logic': 'analysis', 'information_extraction': 'analysis', 'deep_tech': 'analysis',
      'performance': 'refinement', 'fast_iteration': 'refinement', 'scenario_fitting': 'refinement',
      'chinese_optimization': 'refinement',
    };
    const agentScores = agentsConfig
      .filter(a => a.model_cli)
      .map(agent => {
        let score = 0;
        for (const cap of requiredCaps.slice(0, 3)) {
          if ((agent.capabilities || []).some(c => capToCapMap[c] === cap)) {
            score += 1;
          }
          if ((agent.scenarios || []).some(s => {
            if (cap === 'code' && (s.includes('development') || s.includes('algorithm'))) return true;
            if (cap === 'architecture' && s.includes('architecture')) return true;
            if (cap === 'text' && (s.includes('document') || s.includes('content'))) return true;
            return false;
          })) {
            score += 0.5;
          }
        }
        return { name: agent.name, score, capabilities: agent.capabilities || [] };
      })
      .sort((a, b) => b.score - a.score);

    // 最高分 Agent 作为执行者
    const executor = agentScores.length > 0 ? agentScores[0].name : '克劳德';

    // 其余 Agent 作为评审者（至少 2 个，且不同于 executor）
    const reviewers = agentScores
      .filter(a => a.name !== executor)
      .slice(0, 2)
      .map(a => a.name);

    // 如果评审者不足 2 个，用克劳德补足（克劳德评审克劳德产出的场景）
    if (reviewers.length < 2) {
      // 优先补一个已有的其他 agent
      const remaining = agentsConfig
        .filter(a => !reviewers.includes(a.name) && a.name !== executor)
        .map(a => a.name);
      for (const r of remaining) {
        if (reviewers.length >= 2) break;
        reviewers.push(r);
      }
      // 还不够就用 exec 的名字但标记为 reviewer 角色
      while (reviewers.length < 2) {
        reviewers.push(executor);
      }
    }

    return {
      executor,
      reviewers: reviewers.slice(0, 2),
      capabilities: requiredCaps.slice(0, 3),
    };
  }

  /**
   * 并行评审 — 调用多个 reviewer agent
   */
  async _parallelReview(task, executorOutput, reviewerNames) {
    const reviews = [];
    const promises = reviewerNames.map(async (name) => {
      const agent = agentRuntime.agents.get(name);
      if (!agent || !agent.adapter) {
        return { reviewer: name, verdict: 'pass', content: '无法连接 Agent，自动通过', reason: '' };
      }
      if (!agent.online) {
        return { reviewer: name, verdict: 'pass', content: 'Agent 离线，自动通过', reason: '' };
      }

      try {
        const reviewInput = {
          task_id: task.task_id,
          role: 'reviewer',
          context: `你是一个多智能体协作平台中的代码/内容评审者（${name}）。请评审以下产出。

任务名称: ${task.name}
任务描述: ${task.description || '无'}
任务类型: ${task.task_type || 'development'}`,
          instruction: `请评审以下执行者（${task.executor_agent}）的产出，给出你的意见。

## 产出内容

${executorOutput}

## 评审要求

请从以下几个方面评审：
1. 正确性：是否满足任务需求
2. 完整性：是否覆盖全部要求
3. 代码质量/内容质量：是否规范、可读
4. 改进建议：是否有可优化的地方

请以以下格式回复：

**评审结论**: [通过 / 需修改 / 驳回]
**理由**: [简要说明]
**改进建议**: [如有，列出具体建议]`,
          max_tokens: 2048,
        };

        const streamId = 'rev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        eventBus.emit('agent:stream:start', { task_id: task.task_id, agent: name, stream_id: streamId });
        let revBuf = '';
        let revLast = 0;
        const onRevChunk = (chunk) => {
          revBuf += chunk;
          const now = Date.now();
          if (revBuf && now - revLast >= 80) {
            revLast = now;
            eventBus.emit('agent:stream:chunk', { task_id: task.task_id, agent: name, chunk: revBuf, stream_id: streamId });
            revBuf = '';
          }
        };

        const result = await agent.adapter.execute(reviewInput, onRevChunk);
        if (revBuf) {
          eventBus.emit('agent:stream:chunk', { task_id: task.task_id, agent: name, chunk: revBuf, stream_id: streamId });
        }
        eventBus.emit('agent:stream:end', { task_id: task.task_id, agent: name, stream_id: streamId });

        // 解析评审结论
        let verdict = 'pass';  // 默认通过
        const content = result.content || '';
        if (content.includes('驳回') || content.includes('不通过') || content.includes('拒绝')) {
          verdict = 'reject';
        } else if (content.includes('需修改') || content.includes('修改') || content.includes('改进')) {
          verdict = 'revise';
        }

        return { reviewer: name, verdict, content, reason: '' };
      } catch (e) {
        return { reviewer: name, verdict: 'pass', content: '评审出错: ' + e.message, reason: '' };
      }
    });

    const results = await Promise.all(promises);
    reviews.push(...results);
    return reviews;
  }

  /**
   * 评审冲突裁决 — 少数服从多数，票数均等时克劳德裁决
   */
  _adjudicateReviews(reviews) {
    const verdicts = reviews.map(r => r.verdict);
    const passCount = verdicts.filter(v => v === 'pass').length;
    const rejectCount = verdicts.filter(v => v === 'reject').length;
    const reviseCount = verdicts.filter(v => v === 'revise').length;

    if (passCount >= 2) {
      return { action: 'accept', reason: `${passCount}/${reviews.length} 评审通过` };
    }

    if (rejectCount >= 2) {
      const notes = reviews.filter(r => r.verdict === 'reject').map(r => r.content).join('\n\n');
      return { action: 'reject', reason: `${rejectCount}/${reviews.length} 评审驳回`, revisionNotes: notes };
    }

    if (reviseCount >= 2) {
      const notes = reviews.filter(r => r.verdict === 'revise').map(r => r.content).join('\n\n');
      return { action: 'revise', reason: `${reviseCount}/${reviews.length} 建议修改`, revisionNotes: notes };
    }

    // 票数分散（1:1 或 1:1:1），克劳德默认裁决
    const claudeReview = reviews.find(r => r.reviewer === '克劳德');
    if (claudeReview) {
      if (claudeReview.verdict === 'pass') {
        return { action: 'accept', reason: '票数分散，克劳德裁决通过' };
      }
      const notes = reviews.filter(r => r.verdict !== 'pass').map(r => r.content).join('\n\n');
      return { action: 'revise', reason: '票数分散，克劳德裁决需修改', revisionNotes: notes };
    }

    // 没有克劳德评审，取第一个评审意见
    const first = reviews[0];
    if (first.verdict === 'pass') {
      return { action: 'accept', reason: '票数分散，默认通过' };
    }
    return { action: 'revise', reason: '票数分散，默认需修改', revisionNotes: reviews.filter(r => r.verdict !== 'pass').map(r => r.content).join('\n\n') };
  }


  /**
   * 结束/终止任务
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
    eventBus.emit('task:completed', { task_id: taskId });
    return task;
  }

  /**
   * 获取所有任务列表
   */
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
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
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

    const entry = `\n### ${roleLabel}${opts.target ? ` @${opts.target}` : ''} - ${timestamp}\n\n${content}\n\n---\n`;
    fs.appendFileSync(conversationPath, entry);
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

module.exports = new TaskOrchestrator();
