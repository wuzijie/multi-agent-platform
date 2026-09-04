/**
 * Agent 可用名单工具
 *
 * 平台历史版本在多处硬编码「克劳德/吉米/迪普斯克/钱文」四个模型名作为
 * 可选参与者 / 可转交对象 / 可分配执行者。当某个 Agent 在 config/agents.yaml 里
 * 被设为 enabled:false（如吉米暂停使用）时，这些硬编码处仍需列出它，
 * 导致模型可能选中未注册的 Agent。
 *
 * 统一改为从这里取「当前已启用」的名单：config 里 enabled !== false 且
 * 属于已知四模型的 Agent。后续恢复某个模型只需把 config 改回 enabled 即可，
 * 无需再改代码。
 */
const config = require('./config');

// 平台内置的可注册 Agent（与 AgentRuntime.initialize / agents.yaml 保持一致）
const KNOWN_AGENT_NAMES = ['克劳德', '吉米', '迪普斯克', '钱文'];

/** 已启用的 Agent 配置列表（enabled:false 排除） */
function enabledAgents() {
  return (config.agents || []).filter(a => a.enabled !== false && KNOWN_AGENT_NAMES.includes(a.name));
}

/** 已启用的 Agent 名称数组 */
function enabledAgentNames() {
  return enabledAgents().map(a => a.name);
}

module.exports = {
  KNOWN_AGENT_NAMES,
  enabledAgents,
  enabledAgentNames,
};
