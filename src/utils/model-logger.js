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
  // 兜底：至少保留 __dirname 推导的项目根
  if (roots.length === 0) {
    roots.push(path.resolve(__dirname, '..', '..'));
  }
  return roots;
}

const LOG_ROOTS = getLogRoots();

/**
 * 按小时生成日志文件名，如 2026-08-14_02.log
 * 每个文件记录该小时（00:00 - 59:59）内的所有请求和回复
 */
function hourFileName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' +
    pad(date.getMonth() + 1) + '-' +
    pad(date.getDate()) + '_' +
    pad(date.getHours()) + '.log'
  );
}

/**
 * 模型 CLI 请求/响应日志记录器
 *
 * 日志位置：logs/agent/ 目录
 * 文件命名：YYYY-MM-DD_HH.log（按日期 + 小时命名）
 * 每个文件记录 1 小时内（该小时的 00:00 - 59:59）的所有请求和回复
 *
 * 日志格式（每行一条 JSON）：
 * {
 *   "timestamp": "2026-08-12T10:30:00.123Z",
 *   "adapter": "ClaudeAdapter" | "KimiAdapter",
 *   "direction": "request" | "response",
 *   "model": "claude-sonnet-4-6" | "kimi-k2.6" | ...,
 *   "content": "..."
 * }
 */
class ModelLogger {
  /**
   * 记录一条日志
   */
  static log(adapterName, direction, model, content) {
    const now = new Date();
    const entry = {
      timestamp: now.toISOString(),
      adapter: adapterName,
      direction,
      model: model || 'default',
      content: content || '',
    };
    const line = JSON.stringify(entry) + '\n';

    // 写入所有可用路径的 logs/agent/ 目录，按小时滚动
    for (const root of LOG_ROOTS) {
      try {
        const logDir = path.join(root, 'logs', 'agent');
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        const logFile = path.join(logDir, hourFileName(now));
        fs.appendFileSync(logFile, line);
      } catch (e) {
        // 某些路径不可写（如 /Volumes 在 VM 中不可见），静默跳过
      }
    }
  }

  /**
   * 记录请求
   */
  static logRequest(adapterName, model, content) {
    this.log(adapterName, 'request', model, content);
  }

  /**
   * 记录响应
   */
  static logResponse(adapterName, model, content) {
    this.log(adapterName, 'response', model, content);
  }

  /**
   * 读取某个日志根目录下所有小时文件中的条目
   */
  static _readEntriesFromRoot(logDir) {
    let entries = [];
    if (!fs.existsSync(logDir)) return entries;
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(logDir, file), 'utf8');
        const lines = raw.trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line));
          } catch (e) {
            // 跳过损坏行
          }
        }
      } catch (e) {
        // skip unreadable files
      }
    }
    return entries;
  }

  /**
   * 读取最近的 N 条日志
   */
  static getRecentLogs(count = 100) {
    let allEntries = [];
    for (const root of LOG_ROOTS) {
      allEntries = allEntries.concat(
        this._readEntriesFromRoot(path.join(root, 'logs', 'agent'))
      );
    }
    allEntries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return allEntries.slice(0, count);
  }

  /**
   * 按适配器筛选日志
   */
  static getLogsByAdapter(adapterName, count = 100) {
    const all = this.getRecentLogs(count * 2);
    return all.filter(e => e.adapter === adapterName).slice(0, count);
  }

  /**
   * 按方向筛选日志（request / response）
   */
  static getLogsByDirection(direction, count = 100) {
    const all = this.getRecentLogs(count * 2);
    return all.filter(e => e.direction === direction).slice(0, count);
  }
}

module.exports = ModelLogger;
