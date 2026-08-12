const fs = require('fs');
const path = require('path');

/**
 * 获取日志写入路径列表
 * 优先 /Volumes（Write 工具可达），回退 /sessions（VM 可达）
 */
function getLogFilePaths() {
  const candidates = [
    '/Volumes/data/we-work/multi-agent-platform',
    path.resolve(__dirname, '..', '..'),
  ];
  const paths = [];
  const seen = new Set();
  for (const root of candidates) {
    const logFile = path.join(root, 'logs', 'agents', 'model_cli.log');
    if (!seen.has(logFile)) {
      seen.add(logFile);
      // 只返回目录存在的路径
      const logDir = path.dirname(logFile);
      if (fs.existsSync(logDir)) {
        paths.push(logFile);
      }
    }
  }
  // 如果没有任何路径可用，至少保留 __dirname 推导的路径
  if (paths.length === 0) {
    paths.push(path.join(path.resolve(__dirname, '..', '..'), 'logs', 'agents', 'model_cli.log'));
  }
  return paths;
}

const LOG_FILES = getLogFilePaths();

/**
 * 模型 CLI 请求/响应日志记录器
 *
 * 日志格式（每行一条 JSON）：
 * {
 *   "timestamp": "2026-08-12T10:30:00.123Z",
 *   "adapter": "ClaudeAdapter" | "KimiAdapter",
 *   "direction": "request" | "response",
 *   "model": "claude-sonnet-4-6" | "kimi-k2-thinking" | ...,
 *   "content": "..."
 * }
 */
class ModelLogger {
  /**
   * 记录一条日志
   */
  static log(adapterName, direction, model, content) {
    const entry = {
      timestamp: new Date().toISOString(),
      adapter: adapterName,
      direction,
      model: model || 'default',
      content: content || '',
    };
    const line = JSON.stringify(entry) + '\n';

    // 写入所有可用路径
    for (const logFile of LOG_FILES) {
      try {
        const logDir = path.dirname(logFile);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
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
   * 读取最近的 N 条日志
   */
  static getRecentLogs(count = 100) {
    // 尝试从所有路径读取，取最新的
    let allEntries = [];
    for (const logFile of LOG_FILES) {
      try {
        if (!fs.existsSync(logFile)) continue;
        const raw = fs.readFileSync(logFile, 'utf8');
        const lines = raw.trim().split('\n').filter(l => l.trim());
        const entries = lines.map(l => JSON.parse(l));
        allEntries = allEntries.concat(entries);
      } catch (e) {
        // skip unreadable files
      }
    }
    allEntries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
