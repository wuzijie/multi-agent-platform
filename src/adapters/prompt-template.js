/**
 * 统一 Prompt 模板入口（四个适配器共用）
 *
 * 已收敛到 src/prompt/renderer.js：相同内容来自模板文件，不同内容
 * （模型名称、模型能力、Agent 名称等）通过变量注入。
 *
 * 布局原则（KV 前缀缓存）：
 *   1. 头部（身份 / 任务ID / 要求 / 能力）—— 会话内不变
 *   2. context —— ZONE A 稳定上下文（工具、团队规则、会话目标、冻结记忆）
 *   3. instruction —— 对话转录 / 本轮指令（只追加，不改写）
 *
 * 易变内容必须放在 instruction 的尾部，禁止插入到头部或 context 中部。
 */
const renderer = require('../prompt/renderer');

/**
 * @param {object} opts
 * @param {string} [opts.agentName]  智能体名（克劳德/迪普斯克/钱文/吉米），用于注入能力档案
 * @param {string} [opts.agentLabel] 向后兼容：无 agentName 时的展示名
 * @param {string} opts.role         角色（executor/reviewer/guardian）
 * @param {string} [opts.modelCli]   model_cli（兜底注入底层模型展示名）
 * @param {string} opts.taskId
 * @param {string} opts.context
 * @param {string} opts.instruction
 */
function buildPrompt({ agentName, agentLabel, role, taskId, context, instruction, modelCli }) {
  return renderer.buildPrompt({
    agentName: agentName || agentLabel || '克劳德',
    role,
    taskId,
    context,
    instruction,
    modelCli,
  });
}

module.exports = { buildPrompt };
