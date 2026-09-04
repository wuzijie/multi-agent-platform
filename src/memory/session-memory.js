/**
 * Session Memory - 会话级短期记忆模块
 *
 * 按《Multi-agent 平台两层 Memory 机制详细设计文档》第 2、3 章实现：
 * - 存储根目录 agent_memory/sessions/{session_id}/
 *   summary.md    会话完整摘要（唯一记忆文件，由后台 subagent 按模板填写并覆盖更新）
 * - 所有文件采用 Markdown + YAML frontmatter（2.2 元信息规范）
 *
 * 本模块实现：
 * - ensureSession：初始化模板
 * - writeFull：后台 subagent 生成完整 summary.md 后覆盖写入
 * - read / hasMemory：读取
 * - writeWorklogEntry：仅追加 Worklog 条目（轻量兜底，非完整摘要）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MEMORY_ROOT = path.join(ROOT, 'agent_memory');
const SESSIONS_DIR = path.join(MEMORY_ROOT, 'sessions');

function tsIso() {
  return new Date().toISOString();
}

function safeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
}

function stripFrontmatter(raw) {
  if (!raw) return '';
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? raw.slice(m[0].length) : raw;
}

function buildFrontmatter(meta) {
  const lines = ['---'];
  const order = ['name', 'title', 'description', 'type', 'scope', 'session_id', 'project_id', 'team_id', 'created_at', 'updated_at', 'agent', 'tags', 'sources'];
  for (const k of order) {
    if (meta[k] === undefined || meta[k] === null) continue;
    const v = meta[k];
    if (Array.isArray(v)) {
      lines.push(k + ': [' + v.map(function(x) { return JSON.stringify(String(x)); }).join(', ') + ']');
    } else if (typeof v === 'string') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// Session Memory 模板（用户指定）--作为 prompt 的核心指令发给 subagent
const SESSION_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

/**
 * 构建 subagent 的 session memory 写入 prompt：
 * 把模板 + 当前对话内容（用户输入 + Agent输出 + 已有 summary）发给 subagent，
 * 让它按模板各节填充完整内容后输出完整 summary.md 正文。
 */
function buildMemoryPrompt({ userInput, agentOutput }) {
  return [
    '你是一个会话记忆管理助手。你的任务是按照模板，对当前对话内容进行分析和总结，输出一份完整的 summary.md 正文内容。',
    '',
    '请严格按照以下模板结构输出，每个节都要根据对话内容填写实质内容（不要保留占位符文字）：',
    '如果某个节在当前对话中没有相关内容，填写「（本轮暂无）」。',
    'Worklog 节请追加到已有内容之后（如果已有内容存在），不要删除之前的记录。',
    '',
    '=== 模板 ===',
    SESSION_TEMPLATE,
    '=== 当前对话内容 ===',
    '',
    '[用户输入]',
    userInput || '(无)',
    '',
    '[Agent输出]',
    agentOutput || '(无)',
  ].join('\n');
}

class SessionMemory {
  constructor() {
    this.projectId = 'multi-agent-platform';
    this._ensureRoot();
  }

  _ensureRoot() {
    if (!fs.existsSync(MEMORY_ROOT)) fs.mkdirSync(MEMORY_ROOT, { recursive: true });
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  /**
   * 确保会话目录与 summary.md 存在（首次初始化为模板）
   */
  ensureSession(sessionId, opts = {}) {
    if (!sessionId) throw new Error('SessionMemory: sessionId 必填');
    this._ensureRoot();
    const dir = path.join(SESSIONS_DIR, safeName(sessionId));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const summaryPath = path.join(dir, 'summary.md');
    if (!fs.existsSync(summaryPath)) {
      const now = tsIso();
      const meta = {
        name: 'summary',
        title: opts.title || `会话摘要 - ${sessionId}`,
        description: '会话完整摘要（主索引，追加式写入）',
        type: 'session_summary',
        scope: 'session',
        session_id: sessionId,
        project_id: opts.projectId || this.projectId,
        created_at: now,
        updated_at: now,
        agent: opts.agent,
      };
      fs.writeFileSync(summaryPath, buildFrontmatter(meta) + '\n\n' + SESSION_TEMPLATE);
    }
    return summaryPath;
  }

  /**
   * 完整摘要写入（后台 subagent 生成完整正文后覆盖写入）
   * 保留 frontmatter，更新 updated_at，正文替换为 subagent 输出。
   * @param {string} sessionId
   * @param {string} fullContent 完整 summary.md 正文（subagent 按模板生成）
   * @param {object} opts { projectId, agent, title }
   * @returns {string} summary.md 路径
   */
  writeFull(sessionId, fullContent, opts = {}) {
    const summaryPath = this.ensureSession(sessionId, opts);
    const now = tsIso();
    // 读取已有 frontmatter（保留 created_at 等）
    let existingMeta = {};
    try {
      const raw = fs.readFileSync(summaryPath, 'utf8');
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) {
        for (const line of fm[1].split('\n')) {
          const m = line.match(/^(\w+):\s*(.+)$/);
          if (m) existingMeta[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch (e) { /* ignore */ }

    const meta = {
      name: 'summary',
      title: opts.title || existingMeta.title || `会话摘要 - ${sessionId}`,
      description: existingMeta.description || '会话完整摘要（主索引，追加式写入）',
      type: 'session_summary',
      scope: 'session',
      session_id: sessionId,
      project_id: opts.projectId || existingMeta.project_id || this.projectId,
      created_at: existingMeta.created_at || now,
      updated_at: now,
      agent: opts.agent || existingMeta.agent,
    };
    const body = buildFrontmatter(meta) + '\n\n' + (fullContent || SESSION_TEMPLATE);
    fs.writeFileSync(summaryPath, body);
    return summaryPath;
  }

  /**
   * 轻量兜底：仅追加一条 Worklog 记录（不走 subagent，保证有最低限度落盘）
   */
  writeWorklogEntry(sessionId, content, opts = {}) {
    const summaryPath = this.ensureSession(sessionId, opts);
    this._touchFrontmatter(summaryPath);
    const entry = `\n- [${tsIso()}] ${content || ''}\n`;
    fs.appendFileSync(summaryPath, entry);
    return summaryPath;
  }

  /** read（去 frontmatter） */
  read(sessionId) {
    if (!sessionId) return '';
    const summaryPath = path.join(SESSIONS_DIR, safeName(sessionId), 'summary.md');
    if (fs.existsSync(summaryPath)) {
      return stripFrontmatter(fs.readFileSync(summaryPath, 'utf8')).trim();
    }
    return '';
  }

  /** hasMemory */
  hasMemory(sessionId) {
    if (!sessionId) return false;
    return fs.existsSync(path.join(SESSIONS_DIR, safeName(sessionId), 'summary.md'));
  }

  /** 更新 frontmatter 的 updated_at */
  _touchFrontmatter(summaryPath) {
    try {
      const raw = fs.readFileSync(summaryPath, 'utf8');
      const now = tsIso();
      const updated = raw.replace(/(updated_at:\s*").*?("\s*$)/m, `$1${now}$2`);
      if (updated !== raw) fs.writeFileSync(summaryPath, updated);
    } catch (e) { /* ignore */ }
  }

  /** 兼容旧调用 */
  writeIncremental(sessionId, content, opts = {}) {
    return this.writeWorklogEntry(sessionId, content, opts);
  }
  appendSummary(sessionId, content, opts = {}) {
    return this.writeWorklogEntry(sessionId, content, opts);
  }
}

module.exports = new SessionMemory();
module.exports.SessionMemory = SessionMemory;
module.exports.buildFrontmatter = buildFrontmatter;
module.exports.stripFrontmatter = stripFrontmatter;
module.exports.safeName = safeName;
module.exports.tsIso = tsIso;
module.exports.MEMORY_ROOT = MEMORY_ROOT;
module.exports.SESSIONS_DIR = SESSIONS_DIR;
module.exports.SESSION_TEMPLATE = SESSION_TEMPLATE;
module.exports.buildMemoryPrompt = buildMemoryPrompt;
