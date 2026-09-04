/**
 * fetch_full 工具 handler
 *
 * 在多模型协作讨论中，按键值从黑板拉取某条消息的完整正文。
 * 模型在历史摘要中看到 full_key，判断需要某条全量细节时调用本工具。
 */
const blackboard = require('../blackboard/blackboard');

async function handler(args, ctx) {
  const key = args && args.key;
  if (!key) return '错误：缺少 key 参数';
  const full = blackboard.get(key);
  if (!full || full === null) return `未找到键值 ${key} 对应的内容（可能已过期或不存在）`;
  return full;
}

module.exports = { handler };
