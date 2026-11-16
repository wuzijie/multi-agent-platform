/**
 * 会话日志存储（LogStore）——按天分文件夹、按会话分文件
 *
 * 目录结构：
 *   logs/YYYY-MM-DD/<session_id>.log   —— 该会话当天的全部日志（JSONL）
 *   logs/YYYY-MM-DD/_system.log        —— 无会话归属的系统级日志（如心跳/页面埋点）
 *
 * 一条日志 = 一行 JSON，公共字段：
 *   timestamp   写入时间（ISO）
 *   log_type    model | collab | event | analytics —— 区分日志类别
 *   session_id  会话 ID（对话级 task_id；无会话为空串）
 *
 * 说明：
 *   - 「会话」= 对话级 task_id（外部平台的 task_id / external_task_id）。
 *     一次对话的模型请求、协作链路、事件、埋点都落在同一个会话文件里。
 *   - 会话可能跨天延续，读取时需扫描所有日期文件夹（listDays）。
 *   - 日志根目录优先 /Volumes（宿主机可达），回退项目根（VM 可达）。
 */
const fs = require('fs');
const path = require('path');

/**
 * 日志根目录候选列表
 * 优先 /Volumes（Write 工具可达），回退项目根目录（VM 可达）
 */
function getLogRoots() {
  const candidates = [
    '/Volumes/data/we-work/multi-agent-platform',
    path.resolve(__dirname, '..', '..'),
  ];
  const roots = [];
  const seen = new Set();
  for (const root of candidates) {
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  if (roots.length === 0) {
    roots.push(path.resolve(__dirname, '..', '..'));
  }
  return roots;
}

const LOG_ROOTS = getLogRoots();

const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地日期 → 文件夹名：2026-11-14 */
function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' +
    pad(date.getMonth() + 1) + '-' +
    pad(date.getDate())
  );
}

/** 会话 ID → 文件名（过滤路径分隔符等非法字符） */
function sessionFileName(sessionId) {
  const s = sessionId === null || sessionId === undefined ? '' : String(sessionId).trim();
  if (!s || s === '_system') return '_system.log';
  const safe = s.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${safe || '_system'}.log`;
}

/**
 * 追加一条日志到对应会话文件（写第一个可写根目录）
 *
 * @param {string} sessionId 会话 ID（对话级 task_id）；空值写入 _system.log
 * @param {Object} entry     日志条目（timestamp/log_type/session_id 缺省时自动补）
 * @returns {boolean} 是否写入成功
 */
function append(sessionId, entry = {}) {
  const now = new Date();
  const ts = entry.timestamp || now.toISOString();
  const sid = entry.session_id || sessionId || '';
  const record = Object.assign({}, entry, {
    timestamp: ts,
    session_id: sid,
  });
  const line = JSON.stringify(record) + '\n';
  const dirName = dayKey(now);
  const fileName = sessionFileName(sid);

  for (const root of LOG_ROOTS) {
    try {
      const logDir = path.join(root, 'logs', dirName);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.appendFileSync(path.join(logDir, fileName), line);
      return true; // 只写第一个可写路径
    } catch (e) {
      // 跳过不可写路径，尝试下一个
    }
  }
  return false;
}

/** 解析一个 .log 文件为条目数组（跳过损坏行） */
function readFile(file) {
  const entries = [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { entries.push(JSON.parse(trimmed)); } catch (e) { /* 跳过损坏行 */ }
    }
  } catch (e) {
    // 文件不可读：返回空
  }
  return entries;
}

/**
 * 列出全部日期文件夹（按日期倒序，去重多根访问同一目录的情况）
 * @returns {Array<{root: string, day: string, dir: string}>}
 */
function listDays() {
  const out = [];
  const seen = new Set();
  for (const root of LOG_ROOTS) {
    const base = path.join(root, 'logs');
    let names = [];
    try {
      names = fs.readdirSync(base).filter(n => DAY_DIR_RE.test(n));
    } catch (e) {
      continue; // 根目录不可读
    }
    for (const name of names) {
      const dir = path.join(base, name);
      let real = dir;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        real = fs.realpathSync(dir);
      } catch (e) {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ root, day: name, dir });
    }
  }
  out.sort((a, b) => b.day.localeCompare(a.day));
  return out;
}

/**
 * 读取某个会话的全部日志（跨所有日期文件夹）
 * @param {string} sessionId 会话 ID
 * @returns {Array<Object>} 条目数组（按文件内顺序拼接，未排序）
 */
function readSessionEntries(sessionId) {
  const s = sessionId === null || sessionId === undefined ? '' : String(sessionId).trim();
  if (!s) return [];
  const fileName = sessionFileName(s);
  const entries = [];
  for (const d of listDays()) {
    const file = path.join(d.dir, fileName);
    if (fs.existsSync(file)) {
      entries.push(...readFile(file));
    }
  }
  return entries;
}

/** 列出某天的日志文件（.log） */
function listDayFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.log'))
      .map(f => path.join(dir, f));
  } catch (e) {
    return [];
  }
}

/**
 * 扫描全部日志条目（日期文件夹从新到旧），支持提前截断
 * @param {Function} [filterFn] 过滤函数
 * @param {Object} [opts]
 * @param {number} [opts.limit] 收集到该数量（按天粒度）后提前停止
 * @returns {Array<Object>} 条目数组（未排序）
 */
function scanEntries(filterFn, opts = {}) {
  const limit = opts.limit || Infinity;
  const out = [];
  for (const d of listDays()) {
    for (const file of listDayFiles(d.dir)) {
      for (const entry of readFile(file)) {
        if (!filterFn || filterFn(entry)) out.push(entry);
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 读取最近的 N 条日志（按 timestamp 倒序）
 * @param {Function} [filterFn] 过滤函数
 * @param {number} [count] 数量上限
 */
function readRecent(filterFn, count = 100) {
  const entries = scanEntries(filterFn, { limit: count });
  entries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return entries.slice(0, count);
}

/**
 * 删除某个会话的全部会话日志文件（跨日期文件夹）
 * 用于「删除对话」时连带清理对应日志
 * @param {string} sessionId 会话 ID（对话级 task_id）
 * @returns {number} 删除的文件数
 */
function deleteSessionLogs(sessionId) {
  const s = sessionId === null || sessionId === undefined ? '' : String(sessionId).trim();
  if (!s) return 0;
  const fileName = sessionFileName(s);
  let removed = 0;
  for (const d of listDays()) {
    const file = path.join(d.dir, fileName);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch (e) {
      // 忽略不可删（权限等），不阻塞对话删除
    }
  }
  return removed;
}

module.exports = {
  LOG_ROOTS,
  dayKey,
  sessionFileName,
  append,
  readFile,
  listDays,
  readSessionEntries,
  scanEntries,
  readRecent,
  deleteSessionLogs,
};
