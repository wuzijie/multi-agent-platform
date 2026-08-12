const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT, 'agents');
const LOG_FILE = path.join(LOG_DIR, 'model_cli.log');

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
    try {
      if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
      }

      const entry = {
        timestamp: new Date().toISOString(),
        adapter: adapterName,
        direction,
        model: model || 'default',
        content: content || '',
      };

      // 追加一行 JSON，保证按时间顺序
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.error(`[ModelLogger] Failed to write log: ${e.message}`);
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
    try {
      if (!fs.existsSync(LOG_FILE)) return [];

      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = raw.trim().split('\n').filter(l => l.trim());
      const entries = lines.map(l => JSON.parse(l));

      // 按时间戳降序，取最近的
      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return entries.slice(0, count);
    } catch (e) {
      console.error(`[ModelLogger] Failed to read logs: ${e.message}`);
      return [];
    }
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
