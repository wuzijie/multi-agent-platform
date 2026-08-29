/**
 * 事件驱动协作方法（从 orchestrator.js 提取，通过 prototype 赋值接入）
 * 方法内的 this 指向 TaskOrchestrator 实例
 */
const { v4: uuidv4 } = require('uuid');
const eventBus = require('../eventbus/bus');
const blackboard = require('../blackboard/blackboard');
const agentRuntime = require('../agent/runtime');
const scheduler = require('../engine/scheduler');
const skillLoader = require('../skills/loader');
const { TASK_STATUS, TASK_TYPES, genSubTaskId } = require('../engine/events');

module.exports = {

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
        const who = d.main_agent || '克劳德';
        const content = `**${who}** 任务拆解\n\n已拆解为 ${lines.length} 个子任务：\n${lines.join('\n')}`;
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
            // 协作子任务是被编排的工作单元：禁用工具循环，防止模型在子任务里
            // 再调 deep_research 形成嵌套（外层调度器超时监控与内层 skill 互相打架）
            subTask.disableTools = true;
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
,

  /**
   * 由主 agent（克劳德）拆解任务，生成子任务 DAG 并指定每个子任务的执行模型
   * 解析失败/调用失败时回退内置默认 DAG
   */
  async _planTask(userQuery, traceId) {
    // 任务拆解交给模型实现：从任务拆解 skill（prompt 型）读取拆解指令，
    // 由模型按指令输出 DAG。skill 缺失时用内置兜底提示词。
    let planPrompt = '';
    try {
      const def = skillLoader.loadSkill('task_planning');
      planPrompt = (def && def.body) || '';
    } catch (e) { planPrompt = ''; }
    if (!planPrompt.trim()) {
      planPrompt = '你是一个多智能体协作平台中的主智能体（克劳德），负责把用户的请求拆解为可执行的子任务 DAG（2-5 个子任务，有依赖关系），并为每个子任务指定执行模型（克劳德/吉米/迪普斯克/钱文）。输出纯 JSON 数组，格式：[{"type":"PLAN_TASK|CODE_TASK|REVIEW_TASK|SUMMARY_TASK|DEBUG_TASK","instruction":"执行指令","deps":[依赖序号],"agent":"克劳德"}]，不要任何其他文字。';
    }
    planPrompt += '\n\n用户请求：' + userQuery;

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
        disableTools: true, // 规划调用不启用工具循环（规划本身就是产出）
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
,

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
,

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
,
};