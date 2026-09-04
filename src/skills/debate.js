/**
 * debate 工具 handler
 * 模型调用 debate 工具时，触发多方辩论编排
 */
async function handler(args, ctx) {
  const orchestrator = require('../orchestrator/orchestrator');
  const task = (ctx && ctx.task) || {};
  const taskId = task.task_id;
  if (!taskId) return '错误：无法确定当前对话ID';
  const topic = (args && args.topic) || '';
  const participants = (args && args.participants) || '';
  try {
    const result = await orchestrator._executeDebateMode(task, taskId, topic, { topic, participants });
    const content = (result && result.result && result.result.content) || '';
    return `多方辩论已完成。以下是讨论纪要：\n\n${content}`;
  } catch (e) {
    return `多方辩论执行失败：${e.message}`;
  }
}

module.exports = { handler };
