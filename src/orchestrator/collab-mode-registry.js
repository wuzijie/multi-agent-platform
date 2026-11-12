/**
 * 固定协作模式注册表
 *
 * “注销”而不是删除：模式实现仍在 src/orchestrator/collab-modes.js，
 * 通过 config/collab-modes.yaml 控制是否允许触发。
 * 默认全部关闭（未配置的模式视为已注销），避免关键词误触发。
 */

const config = require('../utils/config');

const DEFAULTS = {
  debate: false,
  brainstorm: false,
  duel: false,
  discussion: false,
};

function table() {
  const cfg = (config.collabModes || {});
  const out = Object.assign({}, DEFAULTS);
  for (const key of Object.keys(cfg)) {
    const item = cfg[key];
    if (item && typeof item === 'object') out[key] = item.enabled === true;
    else if (typeof item === 'boolean') out[key] = item;
  }
  return out;
}

function isEnabled(mode) {
  if (!mode) return false;
  const t = table();
  return t[mode] === true;
}

function enabledModes() {
  return Object.keys(table()).filter(k => table()[k]);
}

function disabledModes() {
  return Object.keys(table()).filter(k => !table()[k]);
}

module.exports = { isEnabled, enabledModes, disabledModes, table };
