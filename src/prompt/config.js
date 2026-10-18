/**
 * 上下文注入配置
 *
 * 优先级：调用方覆盖 > config/context.yaml > 内置默认值
 * 注意：测试/脚本可能没有调用 config.loadAll()，因此这里必须自带默认值。
 */
const config = require('../utils/config');

const DEFAULTS = {
  enabled: true,
  max_turns: 6,
  max_chars: 12000,
  message_max_chars: 4000,
  compact_threshold: 10000,
  recent_turns_after_compact: 2,
  freeze_memory_per_session: true,
  dag_planner_history_chars: 6000,
  dag_last_result_chars: 2000,
};

function historyConfig(overrides = {}) {
  const loaded = (config.context && config.context.history) || {};
  return { ...DEFAULTS, ...loaded, ...(overrides || {}) };
}

module.exports = { DEFAULTS, historyConfig };
