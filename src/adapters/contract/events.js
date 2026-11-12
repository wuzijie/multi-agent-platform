/**
 * 规范事件模型
 *
 * 适配器把各 CLI 的原生输出翻译成这里的统一事件，运行时只消费这些事件，
 * 不再关心某个 CLI 的 stream-json / text 细节。
 *
 * 事件契约：
 *   session.started  { session_id?, cli, model, resumed }
 *   message.delta    { text }
 *   message.completed{ text, finish_reason? }
 *   tool.call        { id?, name, args? }
 *   tool.result      { id?, ok, output? }
 *   usage            { input_tokens?, output_tokens?, cached_tokens?, cost_usd? }
 *   log              { level, message }
 *   error            { code, message, retryable? }
 *   done             { status, exit_code? }
 */

const EVENT = {
  SESSION_STARTED: 'session.started',
  MESSAGE_DELTA: 'message.delta',
  MESSAGE_COMPLETED: 'message.completed',
  TOOL_CALL: 'tool.call',
  TOOL_RESULT: 'tool.result',
  USAGE: 'usage',
  LOG: 'log',
  ERROR: 'error',
  DONE: 'done',
};

const EVENT_TYPES = new Set(Object.values(EVENT));

/**
 * 创建一个规范事件
 * @param {string} type
 * @param {object} data
 * @param {number} [seq]
 */
function createEvent(type, data = {}, seq = 0) {
  if (!EVENT_TYPES.has(type)) {
    throw new Error(`Unknown canonical event type: ${type}`);
  }
  return { type, seq, ts: Date.now(), data };
}

/**
 * 事件流：给适配器用的发射器。
 * - 维护单调 seq
 * - 支持直接传入 onEvent 回调（运行时/测试可订阅）
 * - 自动收集 usage / session_id / 全文，供适配器返回统一输出
 */
class EventStream {
  constructor(onEvent) {
    this.seq = 0;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.sessionId = null;
    this.text = '';
    this.usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: 0 };
    this.error = null;
    this.events = [];
  }

  emit(type, data = {}) {
    const evt = createEvent(type, data, ++this.seq);
    this.events.push(evt);

    if (type === EVENT.SESSION_STARTED && data.session_id) {
      this.sessionId = data.session_id;
    } else if (type === EVENT.MESSAGE_DELTA && typeof data.text === 'string') {
      this.text += data.text;
    } else if (type === EVENT.MESSAGE_COMPLETED && typeof data.text === 'string') {
      // 完整文本以 completed 为准（delta 可能因解析失败不完整）
      if (data.text.length >= this.text.length) this.text = data.text;
    } else if (type === EVENT.USAGE && data) {
      for (const k of Object.keys(this.usage)) {
        if (typeof data[k] === 'number') this.usage[k] += data[k];
      }
    } else if (type === EVENT.ERROR) {
      this.error = data;
    }

    if (this.onEvent) {
      try { this.onEvent(evt); } catch (e) { /* 订阅方异常不影响适配器 */ }
    }
    return evt;
  }
}

module.exports = { EVENT, EVENT_TYPES, createEvent, EventStream };
