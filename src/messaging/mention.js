/**
 * 首行 @ 解析
 *
 * 规则（与产品定稿一致）：
 * - 只识别第一行；第二行及之后的 @ 一律视为普通文本。
 * - 用户消息最多 2 个 @（并行回答同一问题）；模型输出最多 1 个。
 * - 超过上限：返回 error，调用方拒绝执行（用户）/ 忽略转交（模型）。
 * - @ 到不存在或已停用的智能体：返回 error + 可用名单，不静默忽略。
 * - 同名重复 @ 自动去重。
 */

function buildAliasMap(agents, aliases) {
  const map = new Map(); // lower name -> canonical name
  for (const a of agents || []) {
    if (!a || !a.name) continue;
    map.set(String(a.name).toLowerCase(), a.name);
    const cli = a.model_cli ? String(a.model_cli).toLowerCase() : null;
    if (cli) map.set(cli, a.name);
    const extra = (aliases && aliases[a.name]) || [];
    for (const alias of extra) map.set(String(alias).toLowerCase(), a.name);
  }
  return map;
}

/**
 * @param {string} text
 * @param {object} opts
 * @param {number} opts.max            允许的最大 @ 数
 * @param {Array} opts.agents          允许的 agent 列表 [{name, model_cli}]
 * @param {object} [opts.aliases]      额外别名 { 中文名: ['claude'] }
 * @returns {{agents:string[], rest:string, error?:{code:string,message:string}}}
 */
function parseLeadingMentions(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  const max = Number.isFinite(opts.max) ? opts.max : 2;
  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const aliasMap = buildAliasMap(agents, opts.aliases);

  const firstLineEnd = raw.indexOf('\n');
  const firstLine = firstLineEnd >= 0 ? raw.slice(0, firstLineEnd) : raw;
  const tail = firstLineEnd >= 0 ? raw.slice(firstLineEnd) : '';

  const trimmed = firstLine.replace(/^\s+/, '');
  if (!trimmed.startsWith('@')) {
    return { agents: [], rest: raw.trim() };
  }

  // 连续解析行首的 @token，token 以空白分隔
  const found = [];
  const unknown = [];
  let cursor = 0;
  let consumedAny = false;

  const tokenRe = /^@([^\s@]+)\s*/;
  while (true) {
    const m = trimmed.slice(cursor).match(tokenRe);
    if (!m) break;
    const token = m[1];
    const canonical = aliasMap.get(token.toLowerCase());
    if (canonical) {
      if (!found.includes(canonical)) found.push(canonical);
      consumedAny = true;
      cursor += m[0].length;
      continue;
    }
    // 只把「行首连续的 @ 段」当作意图；遇到无法识别的 token 直接报错
    unknown.push(token);
    cursor += m[0].length;
    consumedAny = true;
    break;
  }

  if (!consumedAny) {
    return { agents: [], rest: raw.trim() };
  }

  if (unknown.length > 0) {
    const available = agents.map(a => a.name).join('、') || '无';
    return {
      agents: [],
      rest: raw.trim(),
      error: {
        code: 'UNKNOWN_AGENT',
        message: `无法识别的智能体：@${unknown[0]}。可用：${available}`,
      },
    };
  }

  if (found.length > max) {
    return {
      agents: [],
      rest: raw.trim(),
      error: {
        code: 'TOO_MANY_MENTIONS',
        message: max === 1
          ? '模型输出首行最多只允许 @ 一个智能体'
          : `一次最多 @ ${max} 个智能体，当前 @ 了 ${found.length} 个`,
      },
    };
  }

  const restFirstLine = trimmed.slice(cursor).trim();
  const rest = (restFirstLine + tail).trim();
  return { agents: found, rest };
}

module.exports = { parseLeadingMentions, buildAliasMap };
