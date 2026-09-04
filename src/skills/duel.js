/**
 * duel 工具 handler
 * 模型调用 duel 工具时，触发一对一辩论编排
 */
async function handler(args, ctx) {
  const orchestrator = require('../orchestrator/orchestrator');
  const task = (ctx && ctx.task) || {};
  const taskId = task.task_id;
  if (!taskId) return '错误：无法确定当前对话ID';
  const topic = (args && args.topic) || '';
  const agentA = (args && args.agent_a) || '';
  const agentB = (args && args.agent_b) || '';
  try {
    const result = await orchestrator._executeDuelMode(task, taskId, topic, { topic, agent_a: agentA, agent_b: agentB });
    const content = (result && result.result && result.result.content) || '';
    return `一对一辩论已完成。以下是最终结论：\n\n${content}`;
  } catch (e) {
    return `一对一辩论执行失败：${e.message}`;
  }
}

module.exports = { handler };
