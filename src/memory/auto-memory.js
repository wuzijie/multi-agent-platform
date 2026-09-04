/**
 * Auto Memory - 项目级长期记忆模块
 *
 * 按《Multi-agent 平台两层 Memory 机制详细设计文档》第 4、6 章实现：
 * - 存储根目录 agent_memory/projects/{project_id}/
 *   MEMORY.md                   核心索引文件（≤200 行 / ≤25000 字节，两级索引第一级）
 *   {topic-name}.md             主题内容文件（单文件单主题，两级索引第二级）
 *   logs/YYYY/MM/YYYY-MM-DD.md  会话历史日志
 *   team/MEMORY.md + *.md       团队级共享记忆
 * - 所有文件采用 Markdown + YAML frontmatter（2.2 元信息规范）
 * - 读取策略：先加载 MEMORY.md 索引，再按需加载具体主题文件（4.4 按需加载）
 * - 检索策略：元信息优先、正文按需检索、按相关度与更新时间排序（第 6 章）
 */
const fs = require('fs');
const path = require('path');
const { buildFrontmatter, stripFrontmatter, safeName, tsIso, MEMORY_ROOT } = require('./session-memory');

const PROJECTS_DIR = path.join(MEMORY_ROOT, 'projects');

// 合法 type / scope（2.2 规范）
const TOPIC_TYPES = new Set(['session_summary', 'user_preference', 'project_context', 'decision', 'feedback', 'reference']);
const SCOPES = new Set(['project', 'team']);

// 索引体积控制（7.3 检索匹配规则参数）
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25000;

/** 提取 frontmatter 中某个字段的值（用于元信息检索/幂等更新） */
function extractMetaField(raw, key) {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!m) return null;
  const fm = m[0];
  const line = fm.split('\n').find(l => l.startsWith(`${key}:`));
  if (!line) return null;
  const v = line.slice(key.length + 1).trim();
  // 去掉 JSON 引号
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

class AutoMemory {
  constructor() {
    this.projectId = 'multi-agent-platform';
  }

  /** 项目记忆根目录 */
  _projectDir(projectId) {
    return path.join(PROJECTS_DIR, safeName(projectId || this.projectId));
  }

  /** 团队级记忆子目录 */
  _teamDir(projectId) {
    return path.join(this._projectDir(projectId), 'team');
  }

  /** 主题文件存放目录（按 scope 区分） */
  _topicDir(projectId, scope) {
    return scope === 'team' ? this._teamDir(projectId) : this._projectDir(projectId);
  }

  /** 索引文件路径 */
  _indexPath(projectId, scope) {
    return path.join(this._topicDir(projectId, scope), 'MEMORY.md');
  }

  /**
   * 初始化项目记忆目录（幂等）
   * @param {string} projectId
   * @param {object} opts { title }
   * @returns {string} 项目记忆目录
   */
  ensureProject(projectId, opts = {}) {
    const dir = this._projectDir(projectId);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'team'), { recursive: true });
    const indexPath = this._indexPath(projectId, 'project');
    if (!fs.existsSync(indexPath)) {
      const now = tsIso();
      const meta = {
        name: 'memory',
        title: opts.title || `项目长期记忆索引 - ${projectId || this.projectId}`,
        description: 'Auto Memory 核心索引文件（两级索引第一级）',
        type: 'project_context',
        scope: 'project',
        project_id: projectId || this.projectId,
        created_at: now,
        updated_at: now,
      };
      fs.writeFileSync(indexPath, buildFrontmatter(meta) + '\n\n');
    }
    return dir;
  }

  /**
   * 加载核心索引文件内容（会话启动时注入上下文）
   * @param {string} projectId
   * @param {string} [scope='project'] project | team
   * @returns {string} 索引正文（不含 frontmatter），无则返回 ''
   */
  loadIndex(projectId, scope = 'project') {
    const indexPath = this._indexPath(projectId, scope);
    if (!fs.existsSync(indexPath)) return '';
    return stripFrontmatter(fs.readFileSync(indexPath, 'utf8')).trim();
  }

  /**
   * 列出全部主题文件及其原始内容
   * @param {string} projectId
   * @param {string} [scope='project']
   * @returns {Array<{name, file, path, raw, updated_at}>}
   */
  listTopics(projectId, scope = 'project') {
    const dir = this._topicDir(projectId, scope);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
      .map(f => {
        const p = path.join(dir, f);
        const raw = fs.readFileSync(p, 'utf8');
        return {
          name: f.replace(/\.md$/, ''),
          file: f,
          path: p,
          raw,
          updated_at: fs.statSync(p).mtime.toISOString(),
        };
      });
  }

  /**
   * 写入主题记忆文件并更新索引（4.2 两级存储 + 4.3.1 主动写入）
   * 幂等：同名主题覆盖更新，索引条目不重复。
   * @param {string} projectId
   * @param {object} opts { name, title, description, type, content, tags, agent, sources, scope, team_id }
   * @returns {string} 主题文件路径
   */
  writeTopic(projectId, opts = {}) {
    const scope = SCOPES.has(opts.scope) ? opts.scope : 'project';
    this.ensureProject(projectId);
    const name = safeName(opts.name || opts.title);
    if (!name) throw new Error('AutoMemory.writeTopic: name/title 必填');
    const dir = this._topicDir(projectId, scope);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.md`);
    const now = tsIso();
    const existing = fs.existsSync(filePath);
    const meta = {
      name,
      title: opts.title || name,
      description: opts.description || opts.title || name,
      type: TOPIC_TYPES.has(opts.type) ? opts.type : 'project_context',
      scope,
      project_id: projectId || this.projectId,
      team_id: opts.team_id,
      created_at: existing ? (extractMetaField(fs.readFileSync(filePath, 'utf8'), 'created_at') || now) : now,
      updated_at: now,
      agent: opts.agent,
      tags: opts.tags,
      sources: opts.sources,
    };
    const body = buildFrontmatter(meta) + '\n\n' + (opts.content || '');
    fs.writeFileSync(filePath, body);
    // 两级索引第二级：更新 MEMORY.md 指针条目
    this._appendIndexEntry(projectId, {
      name,
      title: opts.title || name,
      description: opts.description || opts.title || name,
    }, scope);
    return filePath;
  }

  /**
   * 向 MEMORY.md 追加/更新索引条目（幂等 + 体积控制）
   * @private
   */
  _appendIndexEntry(projectId, { name, title, description }, scope = 'project') {
    this.ensureProject(projectId);
    const indexPath = this._indexPath(projectId, scope);
    const raw = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    // 保留原 frontmatter
    const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const prefix = fmMatch ? fmMatch[0] : '';
    const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    let lines = body.split('\n').map(l => l.trimEnd()).filter(Boolean);
    // 同名条目幂等替换
    lines = lines.filter(l => !l.includes(`](${name}.md)`));
    const entry = `- [${title}](${name}.md) — ${String(description || '').slice(0, 100)}`;
    lines.push(entry);

    // 体积控制（4.2.1）：先控行数，再控字节；截断不破坏完整条目
    if (lines.length > INDEX_MAX_LINES) lines = lines.slice(lines.length - INDEX_MAX_LINES);
    let content = lines.join('\n');
    while (lines.length > 1 && Buffer.byteLength(content) > INDEX_MAX_BYTES) {
      lines.shift();
      content = lines.join('\n');
    }
    fs.writeFileSync(indexPath, prefix + (content ? content + '\n' : ''));
  }

  /**
   * 按名字读取主题文件内容（两级索引第二级：按指针加载）
   * @param {string} projectId
   * @param {string} name 主题文件名（不含 .md）
   * @param {string} [scope='project']
   * @returns {string} 主题正文（不含 frontmatter），无则返回 ''
   */
  retrieveTopic(projectId, name, scope = 'project') {
    if (!name) return '';
    const p = path.join(this._topicDir(projectId, scope), `${safeName(name)}.md`);
    if (!fs.existsSync(p)) return '';
    return stripFrontmatter(fs.readFileSync(p, 'utf8')).trim();
  }

  /**
   * 关键词检索：元信息优先 → 正文按需检索 → 相关度+更新时间排序（第 6 章）
   * @param {string} projectId
   * @param {string} keyword 空格分隔的多关键词
   * @param {object} [opts] { scope, limit }
   * @returns {Array<{name, title, description, scope, updated_at, score, snippet}>}
   */
  search(projectId, keyword, opts = {}) {
    const scope = opts.scope || 'project';
    const limit = opts.limit || 5;
    const kws = String(keyword || '').split(/\s+/).filter(Boolean);
    if (kws.length === 0) return [];
    const scored = [];
    for (const t of this.listTopics(projectId, scope)) {
      const metaRaw = (t.raw.split('---')[1] || '').toLowerCase();
      const body = stripFrontmatter(t.raw).toLowerCase();
      // 元信息匹配权重 > 正文匹配权重（6.4）
      const metaScore = kws.filter(k => metaRaw.includes(k.toLowerCase())).length;
      const bodyScore = kws.filter(k => body.includes(k.toLowerCase())).length;
      if (metaScore === 0 && bodyScore === 0) continue;
      scored.push({
        name: t.name,
        title: extractMetaField(t.raw, 'title') || t.name,
        description: extractMetaField(t.raw, 'description') || '',
        scope,
        updated_at: t.updated_at,
        score: metaScore * 2 + bodyScore,
        snippet: stripFrontmatter(t.raw).slice(0, 200),
      });
    }
    // 相关度优先，同分按最近更新优先
    scored.sort((a, b) => b.score - a.score || (new Date(b.updated_at) - new Date(a.updated_at)));
    return scored.slice(0, limit);
  }

  /**
   * 追加会话日志到 logs/YYYY/MM/YYYY-MM-DD.md（5.4 会话终止归档）
   * @param {string} projectId
   * @param {string} content
   * @param {object} [opts] { title, agent }
   * @returns {string} 日志文件路径
   */
  appendLog(projectId, content, opts = {}) {
    const dir = path.join(this._projectDir(projectId), 'logs');
    const now = new Date();
    const monthDir = path.join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
    fs.mkdirSync(monthDir, { recursive: true });
    const fname = now.toISOString().slice(0, 10) + '.md';
    const logPath = path.join(monthDir, fname);
    const entry = `\n\n## ${tsIso()} ${opts.title || ''}\n\n${content || ''}\n`;
    fs.appendFileSync(logPath, entry);
    return logPath;
  }
}

module.exports = new AutoMemory();
module.exports.AutoMemory = AutoMemory;
module.exports.PROJECTS_DIR = PROJECTS_DIR;
