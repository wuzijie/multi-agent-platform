/**
 * 通用 ID 生成（原 engine/events.js 的能力；DAG 引擎删除后保留供讨论/辩论等模式使用）
 */
const { v4: uuidv4 } = require('uuid');

/**
 * 生成全局 trace_id（如 debate_20261116_213045_ab12cd34）
 */
function genTraceId(prefix = 'task') {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}_${ts}_${uuidv4().slice(0, 8)}`;
}

module.exports = { genTraceId };
