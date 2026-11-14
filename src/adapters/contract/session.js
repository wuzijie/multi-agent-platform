/**
 * 会话标识工具
 *
 * - 首次调用需要由平台预生成 session id 的 CLI（如 claude --session-id），
 *   统一用 UUID v4；
 * - session 的持久化在 messaging/cursor-store，适配器只负责“用 id 调 CLI + 回报捕获到的 id”。
 */
const crypto = require('crypto');

function newSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

module.exports = { newSessionId };
