/**
 * 机器可读消息日志 messages.jsonl
 *
 * 为什么需要它：
 * - conversation.md 面向人阅读（时间戳、系统提示、markdown 标题），无法稳定做“读到第几条”的游标；
 * - prompt_transcript.jsonl 会被压缩，且只覆盖部分路径。
 *
 * 本文件是「每个 CLI 读到哪」的唯一依据：
 *   {"seq":1,"ts":"...","role":"user","agent":null,"kind":"chat","content":"..."}
 *
 * 约定：
 * - seq 单调递增，由本模块串行分配（Node 单进程 + 同步 append）。
 * - role=system 只用于展示/审计，组装 prompt 时一律过滤。
 * - 内容原样保存，不做截断（截断在组装 prompt 时按预算处理）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE_NAME = 'messages.jsonl';

const _lastSeq = new Map(); // taskId -> number
const _writeQueue = new Map(); // taskId -> Promise（保留位，当前同步写）

function taskDir(taskId) {
  return path.join(ROOT, 'tasks', String(taskId));
}

function filePath(taskId) {
  return path.join(taskDir(taskId), FILE_NAME);
}

function ensureDir(taskId) {
  fs.mkdirSync(taskDir(taskId), { recursive: true });
}

function parseLines(raw) {
  return String(raw || '')
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      try {
        const o = JSON.parse(l);
        if (!o || typeof o.content !== 'string') return null;
        return {
          seq: Number(o.seq) || 0,
          ts: o.ts || null,
          role: o.role || 'assistant',
          agent: o.agent || null,
          kind: o.kind || 'chat',
          content: o.content,
        };
      } catch (e) { return null; }
    })
    .filter(Boolean);
}

function loadAll(taskId) {
  const fp = filePath(taskId);
  if (!fs.existsSync(fp)) return [];
  try {
    const list = parseLines(fs.readFileSync(fp, 'utf8'));
    const max = list.reduce((m, e) => Math.max(m, e.seq), 0);
    _lastSeq.set(String(taskId), max);
    return list;
  } catch (e) {
    return [];
  }
}

function nextSeq(taskId) {
  const key = String(taskId);
  if (!_lastSeq.has(key)) {
    const list = loadAll(taskId);
    _lastSeq.set(key, list.reduce((m, e) => Math.max(m, e.seq), 0));
  }
  const seq = _lastSeq.get(key) + 1;
  _lastSeq.set(key, seq);
  return seq;
}

/**
 * 追加一条消息
 * @returns {number} 分配的 seq
 */
function append(taskId, { role, agent = null, kind = 'chat', content }) {
  if (!taskId || typeof content !== 'string' || !content.trim()) return 0;
  ensureDir(taskId);
  const seq = nextSeq(taskId);
  const entry = {
    seq,
    ts: new Date().toISOString(),
    role: role || 'assistant',
    agent: agent || null,
    kind,
    content,
  };
  fs.appendFileSync(filePath(taskId), JSON.stringify(entry) + '\n');
  return seq;
}

/**
 * 取游标之后的消息（默认过滤 system）
 * @param {string} taskId
 * @param {number} cursorSeq 只返回 seq > cursorSeq
 * @param {{excludeSystem?:boolean, excludeAgent?:string|null}} [opts]
 */
function since(taskId, cursorSeq = 0, opts = {}) {
  const excludeSystem = opts.excludeSystem !== false;
  const excludeAgent = opts.excludeAgent || null;
  return loadAll(taskId).filter(m => {
    if (m.seq <= cursorSeq) return false;
    if (excludeSystem && m.role === 'system') return false;
    if (excludeAgent && m.role === 'assistant' && m.agent === excludeAgent) return false;
    return true;
  });
}

function maxSeq(taskId) {
  const list = loadAll(taskId);
  return list.reduce((m, e) => Math.max(m, e.seq), 0);
}

/**
 * 最近一次真正回复的 agent（用于“无 @ 时承接”）。
 * 只看 role=assistant 且带 agent 的消息。
 */
function latestAssistantAgent(taskId) {
  const list = loadAll(taskId);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role === 'assistant' && m.agent) return m.agent;
  }
  return null;
}

/**
 * 老会话回填：从 conversation.md 解析出消息写进 messages.jsonl。
 * 只在文件不存在时执行一次。
 * @returns {number} 写入条数
 */
function backfillFromConversation(taskId) {
  const fp = filePath(taskId);
  if (fs.existsSync(fp)) return 0;

  const convPath = path.join(taskDir(taskId), 'conversation.md');
  if (!fs.existsSync(convPath)) return 0;

  const raw = fs.readFileSync(convPath, 'utf8');
  const headerRe = /^### (🧑 用户|🤖 助手|⚙️ 系统|🤖 (克劳德|吉米|迪普斯克|钱文))(?: @[^\n-]+)?[^\n]*$/gm;
  const starts = [];
  let m;
  while ((m = headerRe.exec(raw)) !== null) {
    starts.push({ pos: m.index, role: m[1], agent: m[2] || null, headerLen: m[0].length });
  }

  let count = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const bodyStart = s.pos + s.headerLen;
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].pos : raw.length;
    const content = raw.slice(bodyStart, bodyEnd).replace(/^\n+/, '').replace(/\n---\n?$/, '').trim();
    if (!content) continue;

    let role = 'assistant';
    if (s.role.includes('用户')) role = 'user';
    else if (s.role.includes('系统')) role = 'system';
    // 模型间转交的提问在 header 里带模型名 → 视为 user，agent 记录发送方
    if (s.agent && !s.role.includes('助手') && !s.role.includes('系统')) role = 'user';

    append(taskId, { role, agent: s.agent, kind: 'backfill', content });
    count++;
  }
  return count;
}

/** 确保消息日志存在（缺省时从 conversation.md 回填） */
function ensure(taskId) {
  if (!fs.existsSync(filePath(taskId))) {
    backfillFromConversation(taskId);
  }
}

module.exports = {
  FILE_NAME,
  filePath,
  loadAll,
  append,
  since,
  maxSeq,
  latestAssistantAgent,
  backfillFromConversation,
  ensure,
};
