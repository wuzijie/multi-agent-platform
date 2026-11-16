const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const LogStore = require('../utils/log-store');

const ROOT = path.resolve(__dirname, '..', '..');

// 高频事件不持久化（避免同步写盘阻塞 event loop，导致并发对话饿死）
const SKIP_PERSIST = new Set([
  'agent:stream:chunk',    // 每 80ms 一次，频率极高
  'agent:stream:start',
  'agent:stream:end',
  'agent:stream:reasoning', // 思考内容：不落盘（敏感且体积大）
  'agent:heartbeat',       // 每 5s 一次
  'collab:subtask:update', // 状态更新频繁
]);

/**
 * File Event Bus
 *
 * 基于文件系统的简易事件总线：
 * - 内存中基于 EventEmitter 实现模块间事件通知（不阻塞 event loop）
 * - 事件异步持久化到「按天文件夹 + 按会话文件」的会话日志：
 *     logs/YYYY-MM-DD/<session_id>.log  （log_type="event"，会话取事件的 data.task_id）
 *     logs/YYYY-MM-DD/_system.log       （无会话归属的系统级事件）
 *   高频事件跳过持久化，避免同步写盘阻塞并发
 */
class FileEventBus extends EventEmitter {
  constructor() {
    super();
    // 旧结构目录（历史事件文件的读取兜底，不再写入）
    this.eventsDir = path.join(ROOT, 'logs', 'events');
    this._ensureDir();
    // 限制监听器数量上限，避免 MaxListenersExceededWarning
    this.setMaxListeners(50);
  }

  _ensureDir() {
    if (!fs.existsSync(this.eventsDir)) {
      fs.mkdirSync(this.eventsDir, { recursive: true });
    }
  }

  /**
   * 发送事件（内存事件立即触发，文件持久化异步/跳过高频事件）
   */
  emit(eventType, data = {}) {
    const timestamp = new Date().toISOString();
    const event = {
      timestamp,
      event_type: eventType,
      data,
    };

    // 异步持久化到会话日志（高频事件跳过，避免阻塞 event loop）
    if (!SKIP_PERSIST.has(eventType)) {
      setImmediate(() => {
        try {
          const sessionId = (data && (data.task_id || data.session_id)) || '';
          LogStore.append(sessionId, {
            log_type: 'event',
            event_type: eventType,
            session_id: sessionId,
            data,
          });
        } catch (e) {
          console.error(`[FileEventBus] Failed to write event log: ${e.message}`);
        }
      });
    }

    // 内存事件立即触发（不阻塞 event loop）
    super.emit(eventType, event);
    super.emit('*', event);

    return true;
  }

  /**
   * 读取最近的 N 条事件（新结构优先，无结果时回退旧 logs/events 目录）
   */
  getRecentEvents(count = 50) {
    const events = LogStore.readRecent(e => !!e.event_type, count);
    if (events.length > 0) return events;

    // 旧结构兜底：logs/events/*.json
    this._ensureDir();
    const files = fs.readdirSync(this.eventsDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, count);

    const legacy = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.eventsDir, file), 'utf8');
        legacy.push(JSON.parse(content));
      } catch (e) {
        // 跳过损坏的文件
      }
    }
    return legacy;
  }

  /**
   * 按类型筛选事件
   */
  getEventsByType(eventType, count = 50) {
    return this.getRecentEvents(count * 3).filter(e => e.event_type === eventType).slice(0, count);
  }
}

module.exports = new FileEventBus();
