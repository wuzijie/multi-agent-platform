/**
 * 统一 Prompt 模板（四个适配器共用）
 *
 * 布局原则（KV 前缀缓存）：
 *   1. 头部（角色 / 任务ID / 要求）—— 会话内不变
 *   2. context —— ZONE A 稳定上下文（工具、团队协作、会话目标、冻结记忆）
 *   3. instruction —— 对话转录 / 本轮指令（只追加，不改写）
 *
 * 易变内容必须放在 instruction 的尾部，禁止插入到头部或 context 中部。
 */
function buildPrompt({ agentLabel, role, taskId, context, instruction }) {
  const roleLabel = {
    'executor': '执行者',
    'reviewer': '评审者',
    'guardian': '愿景守护者',
  }[role] || role;

  const lines = [
    `你是一个多智能体协作平台中的${roleLabel}智能体（${agentLabel}）。`,
    '',
    '## 任务ID',
    String(taskId || ''),
    '',
    '## 要求',
    '- 请根据以上指令完成你的工作',
    '- 直接输出结果内容，不需要多余的说明',
    '- 如果任务涉及代码，请确保代码可以正常运行',
    '- 如果任务不可行，请明确说明原因',
    '',
    String(context || ''),
    '',
    String(instruction || ''),
  ];

  return lines.join('\n');
}

module.exports = { buildPrompt };
