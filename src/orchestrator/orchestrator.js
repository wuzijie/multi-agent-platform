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


// 从单独文件加载大方法（拆分文件，每个<800行）
Object.assign(TaskOrchestrator.prototype, require('./collab'));
Object.assign(TaskOrchestrator.prototype, require('./execution'));

module.exports = new TaskOrchestrator();
