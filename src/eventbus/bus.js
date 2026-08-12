const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * File Event Bus
 *
 * 基于文件系统的简易事件总线：
 * - 内存中基于 EventEmitter 实现模块间事件通知
 * - 同时将事件写入 logs/events/ 目录持久化
 * - 消费者可通过文件变更监听读取历史事件
 */
class FileEventBus extends EventEmitter {
  constructor() {
    super();
    this.eventsDir = path.join(ROOT, 'logs', 'events');
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.eventsDir)) {
      fs.mkdirSync(this.eventsDir, { recursive: true });
    }
  }

  /**
   * 发送事件（同步写入文件 + 触发内存事件）
   */
  emit(eventType, data = {}) {
    const timestamp = new Date().toISOString();
    const event = {
      timestamp,
      event_type: eventType,
      data,
    };

    // 写入持久化文件
    try {
      const filename = `${timestamp.replace(/[:.]/g, '-')}_${eventType}.json`;
      const filePath = path.join(this.eventsDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(event, null, 2));
    } catch (e) {
      console.error(`[FileEventBus] Failed to write event file: ${e.message}`);
    }

    // 触发内存事件
    super.emit(eventType, event);
    super.emit('*', event);

    return true;
  }

  /**
   * 读取最近的 N 条事件
   */
  getRecentEvents(count = 50) {
    this._ensureDir();
    const files = fs.readdirSync(this.eventsDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, count);

    const events = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.eventsDir, file), 'utf8');
        events.push(JSON.parse(content));
      } catch (e) {
        // 跳过损坏的文件
      }
    }
    return events;
  }

  /**
   * 按类型筛选事件
   */
  getEventsByType(eventType, count = 50) {
    return this.getRecentEvents(count * 3).filter(e => e.event_type === eventType).slice(0, count);
  }
}

module.exports = new FileEventBus();
