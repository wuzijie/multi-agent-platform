/**
 * CLI 能力声明与 resume 参数解析
 *
 * 配置来源：config/cli-profiles.yaml
 *   cli_profiles:
 *     defaults: { require_resume: true }
 *     profiles:
 *       claude: { strategy, first_call_args, resume_args, capture, supported }
 *
 * 设计原则：
 * - 运行时不得硬编码某个 CLI 的 flag，一律从这里取；
 * - `supported: false` 的 CLI 视为未通过准入，不允许被调度；
 * - 新增模型只需新增 profile + 翻译器，不改编排层。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'cli-profiles.yaml');

const DEFAULT_PROFILE = {
  strategy: 'none',
  first_call_args: [],
  resume_args: [],
  capture: 'none',
  supported: false,
  probed_at: null,
};

let cache = null;

function load(force = false) {
  if (cache && !force) return cache;
  let raw = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    }
  } catch (e) {
    console.error(`[Capabilities] 读取 ${CONFIG_PATH} 失败: ${e.message}`);
  }
  const section = raw.cli_profiles || raw.profiles || {};
  cache = {
    defaults: Object.assign({ require_resume: true }, section.defaults || {}),
    profiles: section.profiles || {},
  };
  return cache;
}

function getProfile(cli) {
  const cfg = load();
  const own = cfg.profiles[cli] || {};
  const base = Object.assign({}, DEFAULT_PROFILE, own);
  // inherit：DeepSeek 复用 Qwen CLI，参数模板沿用父级，但 supported 仍可独立覆盖
  if (base.strategy === 'inherit' && base.inherit_from) {
    const parent = Object.assign({}, DEFAULT_PROFILE, cfg.profiles[base.inherit_from] || {});
    return Object.assign({}, parent, {
      strategy: parent.strategy,
      first_call_args: parent.first_call_args,
      resume_args: parent.resume_args,
      capture: parent.capture,
      inherit_from: base.inherit_from,
      supported: base.supported !== undefined ? base.supported : parent.supported,
      probed_at: base.probed_at || parent.probed_at,
    });
  }
  return base;
}

/** 是否通过准入（支持 resume 且未被显式禁用） */
function isSupported(cli) {
  const p = getProfile(cli);
  if (p.supported === false) return false;
  return p.strategy !== 'none';
}

function isResumeRequired() {
  return load().defaults.require_resume !== false;
}

/**
 * 构造 resume 相关参数
 * @param {string} cli
 * @param {{sessionId?: string, isFirstCall?: boolean}} opts
 * @returns {string[]}
 */
function buildResumeArgs(cli, opts = {}) {
  const p = getProfile(cli);
  if (!isSupported(cli)) return [];
  const id = opts.sessionId;
  if (!id) return [];
  const tpl = opts.isFirstCall ? p.first_call_args : p.resume_args;
  if (!Array.isArray(tpl) || tpl.length === 0) return [];
  return tpl.map(x => String(x).replace('{session_id}', id));
}

/** 该 CLI 是否需要由我们预生成 session id（首次调用即可指定） */
function needsGeneratedSessionId(cli) {
  const p = getProfile(cli);
  return isSupported(cli) && (p.first_call_args || []).some(a => String(a).includes('{session_id}'));
}

/**
 * 从 CLI 原生输出中捕获 session_id
 * @param {string} cli
 * @param {object|string} native 已解析的 JSON 对象，或原始行
 * @returns {string|null}
 */
function captureSessionId(cli, native) {
  const p = getProfile(cli);
  const source = p.capture || 'none';
  if (source === 'none') return null;

  let obj = native;
  if (typeof native === 'string') {
    const line = native.trim();
    if (!line.startsWith('{')) return null;
    try { obj = JSON.parse(line); } catch (e) { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;

  // Claude Code: {"type":"system","subtype":"init","session_id":"..."}
  if (source === 'stream_json_init') {
    if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id) return obj.session_id;
    if (obj.type === 'result' && obj.session_id) return obj.session_id;
    return null;
  }
  // 通用：顶层 session_id / sessionId / conversation_id
  if (source === 'output_json' || source === 'any') {
    return obj.session_id || obj.sessionId || obj.conversation_id || null;
  }
  return null;
}

/** 探针结果写回（供 scripts/probe-cli.js 使用） */
function recordProbe(cli, result) {
  const cfg = load(true);
  cfg.profiles[cli] = Object.assign({}, getProfile(cli), {
    supported: !!result.supported,
    probed_at: new Date().toISOString(),
    probe_detail: result.detail || null,
  });
  const out = { cli_profiles: { defaults: cfg.defaults, profiles: cfg.profiles } };
  fs.writeFileSync(CONFIG_PATH, yaml.dump(out, { lineWidth: 120 }), 'utf8');
  cache = null;
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_PROFILE,
  load,
  getProfile,
  isSupported,
  isResumeRequired,
  buildResumeArgs,
  needsGeneratedSessionId,
  captureSessionId,
  recordProbe,
};
