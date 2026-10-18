/**
 * 对话历史渲染与截断
 *
 * 设计原则：
 * - 渲染必须是纯函数：同样的消息每次得到逐字节相同的文本，
 *   这是「第 N 轮 prompt 是第 N+1 轮 prompt 前缀」的前提。
 * - 不写入时间戳、轮次序号、随机 id，避免破坏 KV 前缀缓存。
 * - 截断采用“头 + 尾”的确定性策略，同一内容每次截断结果一致。
 */
const { historyConfig } = require('./config');

const TRUNC_MARK = '\n……（内容过长，中间部分已省略）……\n';

/**
 * 确定性截断：保留头 75% + 尾 25%，中间用固定标记代替。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncate(text, maxChars) {
  const s = String(text == null ? '' : text);
  const limit = Number(maxChars) || 0;
  if (limit <= 0 || s.length <= limit) return s;
  const markLen = TRUNC_MARK.length;
  // 预算小于标记本身时退化为硬截断，避免输出反而超长
  if (limit <= markLen + 2) return s.slice(0, limit);
  const headLen = Math.max(1, Math.floor((limit - markLen) * 0.75));
  const tailLen = Math.max(0, limit - markLen - headLen);
  return s.slice(0, headLen) + TRUNC_MARK + (tailLen > 0 ? s.slice(-tailLen) : '');
}

/**
 * 渲染一条对话条目。渲染格式与历史、当前轮共用，保证同构。
 */
function formatEntry(role, content, agentName) {
  const text = String(content == null ? '' : content).trim();
  if (!text) return '';
  if (role === 'user') return `[用户] ${text}`;
  if (role === 'assistant') return `[助手${agentName ? '·' + agentName : ''}] ${text}`;
  if (role === 'tool') return `[工具${agentName ? '·' + agentName : ''}] ${text}`;
  if (role === 'system') return `[系统] ${text}`;
  return text;
}

/**
 * 把 conversation.md 解析出的消息数组渲染成历史片段（兼容旧数据源）。
 * 始终保留首条用户消息（会话锚点），其余从最新往回取，受轮数与字符预算限制。
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [overrides]
 * @returns {string[]}
 */
function buildSegments(messages, overrides = {}) {
  const cfg = historyConfig(overrides);
  if (!cfg.enabled) return [];
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return [];

  const maxMessages = Math.max(2, Number(cfg.max_turns) * 2);
  const sliced = list.slice(-maxMessages);

  // 会话锚点：首条用户消息
  const firstUser = list.find(m => m && m.role === 'user');
  const anchor = (firstUser && !sliced.includes(firstUser)) ? firstUser : null;

  const picked = [];
  let total = 0;
  for (let i = sliced.length - 1; i >= 0; i--) {
    const msg = sliced[i];
    if (!msg || !msg.content) continue;
    const text = String(msg.content);
    if (picked.length > 0 && total + text.length > Number(cfg.max_chars)) break;
    picked.unshift(msg);
    total += text.length;
  }

  const segments = [];
  if (anchor) {
    const anchorText = formatEntry('user', truncate(anchor.content, cfg.message_max_chars));
    if (anchorText) segments.push(anchorText);
  }
  for (const msg of picked) {
    const segment = formatEntry(msg.role, msg.content, msg.agent);
    if (segment) segments.push(segment);
  }
  return segments;
}

module.exports = { TRUNC_MARK, truncate, formatEntry, buildSegments };
