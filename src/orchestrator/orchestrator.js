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
const { enabledAgentNames } = require('../utils/agent-list');
const { TASK_STATUS, TASK_TYPES, genSubTaskId } = require('../engine/events');

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
  // 匹配触发词（在消息开头）+ 可选的"一下/下/关于" + 剩余部分作为主题
  if (m = msg.match(/^(?:头脑风暴|发散思考|方案征集|创意发散|思路拓展|brainstorm)(?:一下|下|关于)?[\s,，：:]*/i)) {
    return { mode: 'brainstorm', topic: msg.substring(m[0].length).trim() || msg };
  }
  if (m = msg.match(/^(?:多模型讨论|多方辩论|多Agent讨论|多智能体讨论|多角度论证|方案论证|debate)(?:一下|下|关于)?[\s,，：:]*/i)) {
    return { mode: 'debate', topic: msg.substring(m[0].length).trim() || msg };
  }
  if (m = msg.match(/^(?:一对一讨论|一对一辩论|两个模型对一下|正反对抗|duel)(?:一下|下|关于)?[\s,，：:]*/i)) {
    return { mode: 'duel', topic: msg.substring(m[0].length).trim() || msg };
  }
  return null;
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
      // 会话级隔离：标记该对话的 session 活跃（独立 thread/session）
      sessionManager.get(taskId).touch();

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

      // 事件驱动协作模式（消息总线 + 黑板 + DAG 编排）
      if (opts.collab_mode === 'event-driven') {
        result = await this._executeEventDrivenCollaboration(task, taskId, userMessage, opts);
        return result;
      }

      // 多模型讨论模式：一条消息中 @了 2 个及以上 Agent
      if (opts.discussion_agents && Array.isArray(opts.discussion_agents)) {
        const valid = opts.discussion_agents.filter(n => enabledAgentNames().includes(n)); // 只允许已启用模型参与（吉米 enabled:false 自动排除）
        const unique = [...new Set(valid)];
        if (unique.length >= 2) {
          result = await this._executeDiscussionMode(task, taskId, userMessage, unique);
          return result;
        }
      }

      // 三类协作模式（debate / brainstorm / duel）：
      // 1. 用户明确通过 collab_mode 指定 -> 直接走对应模式
      // 2. 模型自主调用 FC 工具（debate/brainstorm/duel）-> executor 层拦截后转入
      // 3. 关键词意图路由 -> 用户说"头脑风暴一下"/"多模型讨论一下"等自动触发
      if (opts.collab_mode === 'debate' || opts.collab_mode === 'brainstorm' || opts.collab_mode === 'duel') {
        // 记录用户消息
        this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description, { target: execAgent });
        if (opts.collab_mode === 'debate') {
          result = await this._executeDebateMode(task, taskId, userMessage, opts);
        } else if (opts.collab_mode === 'brainstorm') {
          result = await this._executeBrainstormMode(task, taskId, userMessage, opts);
        } else {
          result = await this._executeDuelMode(task, taskId, userMessage, opts);
        }
        return result;
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

      result = await this._executeAgentWithMentions(task, taskId, userMessage, execAgent, 0, new Set([execAgent]), null);
      return result;
    } finally {
      // Session Memory 写入条件：
      //   1. 对话轮次超过 3 轮
      //   2. 累积对话内容超过 5K 字节（记录后重置缓冲）
      //   3. 对话结束（terminateTask 里单独触发）
      // 不满足条件时只累积，不触发 subagent 写入
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
    // 清空该对话的 session 状态
    const s = sessionManager.get(taskId);
    if (s) { s.busyAgents.clear(); s.traces = []; s.status = 'completed'; }
    CollabLogger.log('task_stopped', { task_id: taskId, killed_procs: killed, cancelled_traces: traces.length });
    eventBus.emit('task:stopped', { task_id: taskId, killed_procs: killed });
    return { task_id: taskId, killed_procs: killed, cancelled_traces: traces.length };
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


// 从单独文件加载大方法（拆分文件，每个<800行）
Object.assign(TaskOrchestrator.prototype, require('./collab'));
Object.assign(TaskOrchestrator.prototype, require('./execution'));
Object.assign(TaskOrchestrator.prototype, require('./collab-modes'));

module.exports = new TaskOrchestrator();
