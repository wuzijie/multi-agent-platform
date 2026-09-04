/**
 * brainstorm 工具 handler
 * 模型调用 brainstorm 工具时，触发头脑风暴编排
 */
async function handler(args, ctx) {
  const orchestrator = require('../orchestrator/orchestrator');
  const task = (ctx && ctx.task) || {};
  const taskId = task.task_id;
  if (!taskId) return '错误：无法确定当前对话ID';
  const topic = (args && args.topic) || '';
  const participants = (args && args.participants) || '';
  try {
    const result = await orchestrator._executeBrainstormMode(task, taskId, topic, { topic, participants });
    const content = (result && result.result && result.result.content) || '';
    return `头脑风暴已完成。以下是最终综合结论：\n\n${content}`;
  } catch (e) {
    return `头脑风暴执行失败：${e.message}`;
  }
}

module.exports = { handler };
