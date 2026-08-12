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

    // 如果用户通过 @mention 指定了 Agent，使用该 Agent
    const mentionedAgent = opts.mentioned_agent || task.executor_agent;
    const execAgent = mentionedAgent || '克劳德';

    task.status = 'executing';
    task.updated_at = new Date().toISOString();
    this._saveTask(task);
    this._updateIndex(task);

    // 追加用户消息到对话记录
    this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description);

    eventBus.emit('task:executing', { task_id: taskId, agent: execAgent });

    const startTime = Date.now();

    try {
      // 读取对话历史
      const conversationHistory = this._readConversationHistory(taskId);

      // 更新 task.instruction 为当前用户消息，确保 Agent 收到正确指令
      const savedInstruction = task.instruction;
      task.instruction = userMessage || task.instruction || task.description;

      // 通过指定 Agent 执行
      const result = await agentRuntime.executeTaskWithAgent(task, conversationHistory, execAgent);

      // 恢复原 instruction
      task.instruction = savedInstruction;

      // 保存输出，带上执行 Agent 的名称标记
      const contentWithAgent = `**${execAgent}**\n\n` + (result.content || '');
      this._appendConversation(taskId, 'assistant', contentWithAgent);

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

    this._appendConversation(taskId, 'user', userMessage || task.instruction || task.description);

    // ===== Step 1: 任务画像生成 =====
    eventBus.emit('task:executing', { task_id: taskId, agent: '多Agent协作', phase: 'profiling' });
    this._appendConversation(taskId, 'system', '[多Agent协作] 开始任务画像分析...');

    const profile = this._generateTaskProfile(task);
    task.executor_agent = profile.executor;
    task.reviewer_agents = profile.reviewers;
    this._saveTask(task);
    this._updateIndex(task);

    this._appendConversation(taskId, 'system',
      `[任务画像] 执行者: ${profile.executor} | 评审者: ${profile.reviewers.join(', ')} | 能力需求: ${profile.capabilities.join(', ')}`);

    // ===== Step 2: Executor 执行 =====
    this._appendConversation(taskId, 'system', `[执行阶段] ${profile.executor} 开始执行任务...`);
    eventBus.emit('task:executing', { task_id: taskId, agent: profile.executor, phase: 'execution' });

    const history = this._readConversationHistory(taskId);
    let execResult;
    try {
      execResult = await agentRuntime.executeTaskWithAgent(task, history, profile.executor);
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

${execResult.content || ''}`);

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

${review.content || review.reason || '（无详细意见）'}`);

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

      const revisedResult = await agentRuntime.executeTaskWithAgent(revisedInput, revisedHistory, profile.executor);

      this._appendConversation(taskId, 'assistant', `**${profile.executor}** 修正后产出:

${revisedResult.content || ''}`);

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

        const result = await agent.adapter.execute(reviewInput);

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
