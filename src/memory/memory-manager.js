/**
 * Memory Manager - 统一记忆管理器
 *
 * 串联 Session Memory（短期工作记忆）+ Auto Memory（长期项目记忆）两层，
 * 遵循《Multi-agent 平台两层 Memory 机制详细设计文档》第 5 章核心交互流程：
 * - buildMemoryContext()   构建注入 Agent 上下文的记忆块
 *                          （Auto Memory 索引 + 相关主题按需加载；Session Memory 不注入 prompt）
 * - saveSessionIncremental() 每轮对话后写入增量摘要（委托 session-memory）
 * - extractMemories()      从 Session Memory 提炼长期记忆（用户偏好/项目知识等）写入 Auto Memory
 * - archiveSessionToLogs() 会话终止时归档 summary 到项目 logs/
 */
const sessionMemory = require('./session-memory');
const autoMemory = require('./auto-memory');

const DEFAULT_PROJECT_ID = 'multi-agent-platform';

// 上下文窗口注入上限（保守预留，避免记忆占满上下文）
const MAX_INDEX_CHARS = 6000;
const MAX_TOPIC_CHARS = 800;
const MAX_TOPICS = 3;

class MemoryManager {
  /**
   * 构建注入 Agent 上下文的记忆块。
   * 只注入 Auto Memory（长期，项目级）：核心索引 + 与当前输入相关的最多 MAX_TOPICS 个主题。
   * Session Memory 不注入 prompt（仅作为 Auto Memory 提取的原材料）。
   * @param {object} opts { taskId, projectId, userInput, taskName, taskDescription }
   * @returns {string} 记忆上下文（无记忆时返回 ''）
   */
  buildMemoryContext(opts = {}) {
    const taskId = opts.taskId;
    const projectId = opts.projectId || DEFAULT_PROJECT_ID;
    if (!taskId) return '';
    const parts = [];

    // Auto Memory（长期，项目级）：索引 + 相关主题按需加载
    try {
      autoMemory.ensureProject(projectId);
      const index = autoMemory.loadIndex(projectId, 'project');
      if (index) {
        parts.push(`【项目长期记忆索引】\n${index.slice(0, MAX_INDEX_CHARS)}`);
      }

      // 按需加载与当前任务相关的主题文件（4.4.3 相关性筛选 + 数量限制）
      const query = [opts.userInput, opts.taskName, opts.taskDescription].filter(Boolean).join(' ');
      if (query) {
        const topics = autoMemory.search(projectId, query, { scope: 'project', limit: MAX_TOPICS });
        if (topics.length > 0) {
          const blocks = topics.map(t => {
            const content = autoMemory.retrieveTopic(projectId, t.name, 'project');
            return `### ${t.title}\n${(content || t.snippet || '').slice(0, MAX_TOPIC_CHARS)}`;
          });
          parts.push(`【相关长期记忆】\n${blocks.join('\n\n')}`);
        }
      }
    } catch (e) {
      // 长期记忆读取失败不影响主流程（记忆为增强项，非关键路径）
    }

    return parts.join('\n\n');
  }

  /** 该会话是否已有短期记忆落盘 */
  hasSessionMemory(taskId) {
    return sessionMemory.hasMemory(taskId);
  }

  /** 每轮对话后写入增量摘要（异步 fire-and-forget 场景） */
  saveSessionIncremental(taskId, summary, opts = {}) {
    return sessionMemory.writeIncremental(taskId, summary, {
      projectId: DEFAULT_PROJECT_ID,
      ...opts,
    });
  }

  /** 完整摘要写入（上下文压缩/会话终止时） */
  saveSessionFull(taskId, summary, opts = {}) {
    return sessionMemory.writeFull(taskId, summary, {
      projectId: DEFAULT_PROJECT_ID,
      ...opts,
    });
  }

  /**
   * 会话终止归档：将 summary.md 同步到 Auto Memory 项目 logs/（5.4 流程第 3 步）
   * @param {string} taskId
   * @param {string} [projectId]
   * @param {object} [opts] { title, agent }
   * @returns {string|null} 日志文件路径
   */
  archiveSessionToLogs(taskId, projectId, opts = {}) {
    const summary = sessionMemory.read(taskId);
    if (!summary) return null;
    return autoMemory.appendLog(projectId || DEFAULT_PROJECT_ID, summary, {
      title: opts.title || `会话 ${taskId} 归档`,
      agent: opts.agent,
    });
  }

  /**
   * 后台提炼长期记忆（4.3.2 extractMemories 补漏写入路径）。
   * 调用方注入 extractFn：(sessionSummary) => [{name,title,description,type,content,tags}]
   * 幂等：同名主题覆盖更新，不重复追加索引条目。
   * @param {string} taskId
   * @param {string} [projectId]
   * @param {Function} extractFn
   * @returns {Promise<Array<{name, path}>>} 写入的主题列表
   */
  async extractMemories(taskId, projectId, extractFn) {
    const summary = sessionMemory.read(taskId);
    if (!summary || typeof extractFn !== 'function') return [];
    const memories = await extractFn(summary);
    const written = [];
    for (const m of memories || []) {
      if (!m || !m.title || !m.content) continue;
      const p = autoMemory.writeTopic(projectId || DEFAULT_PROJECT_ID, {
        name: m.name || m.title,
        title: m.title,
        description: m.description,
        type: m.type,
        content: m.content,
        tags: m.tags,
        agent: m.agent,
        sources: m.sources,
        scope: m.scope || 'project',
      });
      written.push({ name: m.name || m.title, path: p });
    }
    return written;
  }
}

module.exports = new MemoryManager();
module.exports.MemoryManager = MemoryManager;
