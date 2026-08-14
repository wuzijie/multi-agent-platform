const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const agentRuntime = require('../agent/runtime');
const eventBus = require('../eventbus/bus');
const config = require('../utils/config');

const ROOT = path.resolve(__dirname, '..', '..');

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
      executor_agent: '克劳德',
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
  async assessComplexity(taskId) {
    const task = this._loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

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
  async executeSimpleTask(taskId, userMessage) {
    const task = this._loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    task.status = 'executing';
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);

    // 追加用户消息到对话记录
    this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description);

    eventBus.emit('task:executing', { task_id: taskId, agent: '克劳德' });

    const startTime = Date.now();

    try {
      // 读取对话历史
      const conversationHistory = this._readConversationHistory(taskId);

      // 执行
      const result = await agentRuntime.executeTask(task, conversationHistory);

      // 保存输出
      this._appendConversation(taskId, 'assistant', result.content || '');

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

      if (result.status === 'success') {
        // 不标记为 completed，保持 executing 状态以支持多轮对话
        // 用户可以通过左侧「+」新建对话或关闭页面来结束当前对话
        task.progress = Math.min(1.0, (task.progress || 0) + 0.5);
      } else {
        task.status = 'failed';
        task.suspend_reason = result.error ? result.error.message : '执行失败';
      }

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

      // 状态检查：仅允许删除终止/失败/已完成的任务
      const deletableStatuses = ['failed', 'completed', 'suspended'];
      if (!deletableStatuses.includes(task.status)) {
        failed.push({ task_id: taskId, name: task.name, reason: `任务状态为 ${task.status}，不可删除` });
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

  _appendConversation(taskId, role, content) {
    const conversationPath = path.join(ROOT, 'tasks', taskId, 'conversation.md');
    const timestamp = new Date().toISOString();
    const roleLabel = {
      'user': '🧑 用户',
      'assistant': '🤖 助手',
      'system': '⚙️ 系统',
    }[role] || role;

    const entry = `\n### ${roleLabel} - ${timestamp}\n\n${content}\n\n---\n`;
    fs.appendFileSync(conversationPath, entry);
  }

  _readConversationHistory(taskId) {
    const conversationPath = path.join(ROOT, 'tasks', taskId, 'conversation.md');
    if (!fs.existsSync(conversationPath)) return [];
    const raw = fs.readFileSync(conversationPath, 'utf8');
    const messages = [];
    // 简单解析：按 ### 分割
    const sections = raw.split(/\n### /);
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];
      const match = section.match(/^(🧑 用户|🤖 助手|⚙️ 系统)/);
      if (match) {
        let role = 'unknown';
        if (match[1].includes('用户')) role = 'user';
        else if (match[1].includes('助手')) role = 'assistant';
        else if (match[1].includes('系统')) role = 'system';

        const content = section.replace(/^[^\n]+\n\n/, '').replace(/\n---\n?$/, '').trim();
        if (content) {
          messages.push({ role, content });
        }
      }
    }
    return messages;
  }
}

module.exports = new TaskOrchestrator();
