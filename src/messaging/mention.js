/**
 * 行首 @ 解析（多行）+ 交接控制标记
 *
 * 规则（与产品定稿一致）：
 * - 只识别「行首」的 @：一行的首个非空白字符是 @ 才算提及。
 * - 任务描述：@ 独占一行时，描述取 @ 后面的一行（或多行），直到下一个 @ 行、
 *   空行或消息结尾；也兼容「@智能体 描述」同行内联写法。
 * - @ 块只能出现在消息的【最前端】或【最末端】，不能夹在正文中间。
 * - 每个 agent 一次最多 @ max 个【其他】agent，且不能 @ 自己（currentAgent）。
 * - 代码块（``` / ~~~ 围栏、4+ 空格缩进、行首反引号）等非纯文本内容中的 @ 一律不识别；
 *   表格、引用、列表、HTML、表情符等因其不是行首 @，天然不触发。
 * - 每个 @ 必须带任务描述，缺描述返回 error。
 *
 * 交接三选一（2026-11-17）：
 *   ① @agent   转给另一位 agent（原行为）
 *   ② @用户    交还用户（terminal，不 spawn 任何 agent；不计入 agent 上限）
 *   ③ [持球:原因] 持球等待外部条件（hold，不进转交链，本轮结束）
 *   —— 三者互斥：同一回复里既有 @ 又有持球标记 → HOLD_CONFLICT；
 *      @用户 与 @agent 同时出现 → MIXED_HANDOFF。
 */

const HOLD_RE = /^\s*\[持球(?:[:：]\s*(.*?))?\]\s*$/;
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
 * 按行拆分文本，并标记每行是「纯文本」还是「代码」。
 * 围栏代码块（``` / ~~~）、缩进代码（4+ 空格）、行首反引号的行内代码块均视为代码。
 * @returns {Array<{text:string, kind:'text'|'code'}>}
 */
function splitLinesWithCode(text) {
  const raw = String(text == null ? '' : text);
  const lines = raw.split('\n');
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (inFence) {
      // 结束围栏（行首 ``` 或 ~~~）
      if (/^\s{0,3}(```+|~~~+)/.test(line)) inFence = false;
      out.push({ text: line, kind: 'code' });
      continue;
    }
    // 开始围栏
    if (/^\s{0,3}(```+|~~~+)/.test(line)) {
      inFence = true;
      out.push({ text: line, kind: 'code' });
      continue;
    }
    // 缩进代码块（4+ 空格后跟非空内容）或行首反引号（行内代码块）
    if (/^\s{4,}\S/.test(line) || /^\s*`/.test(line)) {
      out.push({ text: line, kind: 'code' });
      continue;
    }
    out.push({ text: line, kind: 'text' });
  }
  return out;
}

/**
 * 解析一行行首连续的 @token（含 @用户 特殊句柄）。
 * @returns {{tokens:string[], userMention:boolean, unknown:string[], inlineRest:string, consumed:boolean}}
 *   tokens     已识别的 agent 规范名（去重，保序；不含 @用户）
 *   userMention 是否出现 @用户（交还用户的终端句柄）
 *   unknown    第一个无法识别的 token（其后不再继续）
 *   inlineRest @token 之后同一行的剩余文本（trim 后）
 *   consumed   是否解析到至少一个 @token
 */
function parseLineMentions(trimmedLine, aliasMap) {
  const tokens = [];
  const unknown = [];
  let userMention = false;
  let cursor = 0;
  let consumed = false;

  const tokenRe = /^@([^\s@]+)\s*/;
  while (true) {
    const m = trimmedLine.slice(cursor).match(tokenRe);
    if (!m) break;
    const token = m[1];
    if (token === '用户') {
      userMention = true;
      consumed = true;
      cursor += m[0].length;
      continue;
    }
    const canonical = aliasMap.get(token.toLowerCase());
    if (canonical) {
      if (!tokens.includes(canonical)) tokens.push(canonical);
      consumed = true;
      cursor += m[0].length;
      continue;
    }
    // 遇到无法识别的 token 直接停下（沿用旧语义：整条报错）
    unknown.push(token);
    cursor += m[0].length;
    consumed = true;
    break;
  }

  const inlineRest = trimmedLine.slice(cursor).trim();
  return { tokens, userMention, unknown, inlineRest, consumed };
}

/**
 * @param {string} text
 * @param {object} opts
 * @param {number} opts.max              允许的最大 @ 数（去重、排除自己之后；@用户 不计入）
 * @param {Array} opts.agents            允许的 agent 列表 [{name, model_cli}]
 * @param {object} [opts.aliases]        额外别名 { 中文名: ['claude'] }
 * @param {string} [opts.currentAgent]   当前发言的 agent（模型输出时排除自己）
 * @returns {{
 *   mentions:Array<{agent:string,description:string}>,
 *   terminal: {description:string}|null,   // @用户
 *   hold: {reason:string}|null,            // [持球:原因]
 *   body:string,
 *   error?:{code:string,message:string}
 * }}
 */
function parseMentions(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  const max = Number.isFinite(opts.max) ? opts.max : 2;
  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const currentAgent = opts.currentAgent || null;
  const aliasMap = buildAliasMap(agents, opts.aliases);

  const lines = splitLinesWithCode(raw);

  // 持球标记：行首独占一行 [持球] / [持球:原因]
  const holdRows = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'text') continue;
    const m = lines[i].text.match(HOLD_RE);
    if (m) holdRows.push({ lineIdx: i, reason: String(m[1] || '').trim() });
  }

  // @ 行（agent 与 @用户 都算）
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'text') continue;
    const trimmed = lines[i].text.replace(/^\s+/, '');
    if (!trimmed.startsWith('@')) continue;
    const p = parseLineMentions(trimmed, aliasMap);
    if (!p.consumed) continue;
    rows.push({ lineIdx: i, ...p });
  }

  if (rows.length === 0 && holdRows.length === 0) {
    return { mentions: [], terminal: null, hold: null, body: raw.trim(), error: null };
  }

  const err = (code, message) => ({
    mentions: [], terminal: null, hold: null, body: raw.trim(),
    error: { code, message },
  });

  // 未知 agent：整条拒绝（沿用旧语义）
  const firstUnknown = rows.find(r => r.unknown.length > 0);
  if (firstUnknown) {
    const available = agents.map(a => a.name).join('、') || '无';
    return err('UNKNOWN_AGENT', `无法识别的智能体：@${firstUnknown.unknown[0]}。可用：${available}`);
  }

  // 持球标记：最多一个，且与 @ 互斥
  if (holdRows.length > 1) {
    return err('HOLD_DUPLICATE', '一次只能有一个 [持球] 标记');
  }
  if (holdRows.length === 1 && rows.length > 0) {
    return err('HOLD_CONFLICT', '[持球] 与 @ 不能同时使用：持球表示等待外部条件，本轮不转交');
  }

  const terminalRow = rows.find(r => r.userMention) || null;
  const agentRows = rows.filter(r => r.tokens.length > 0);

  // @用户 与 @agent 互斥（交接三选一）
  if (terminalRow && agentRows.length > 0) {
    return err('MIXED_HANDOFF', '同一轮只能选择一种交接方式：@agent 或 @用户');
  }

  // 计算每个 @ 行的描述范围
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k];
    if (row.inlineRest) {
      row.description = row.inlineRest;
      row.descEndIdx = row.lineIdx; // 只占该行
      continue;
    }
    // 块描述：从 mention 行之后到下一个 mention 行 / 空行 / 结尾
    const nextMentionLine = (k + 1 < rows.length) ? rows[k + 1].lineIdx : lines.length;
    const descLines = [];
    let j = row.lineIdx + 1;
    let lastConsumed = row.lineIdx;
    while (j < nextMentionLine) {
      const l = lines[j];
      if (l.kind === 'code') { j++; continue; } // 跳过代码行
      if (l.text.trim() === '') break;           // 空行结束描述
      if (HOLD_RE.test(l.text)) break;           // 持球标记不并入描述
      descLines.push(l.text);
      lastConsumed = j;
      j++;
    }
    row.description = descLines.join('\n').trim();
    row.descEndIdx = lastConsumed;
  }

  // 「front or end」约束：@ 块不能夹在正文中间
  if (rows.length > 0) {
    const firstIdx = rows[0].lineIdx;
    const lastDescEnd = Math.max(...rows.map(r => r.descEndIdx));
    const leadingBody = [];
    for (let i = 0; i < firstIdx; i++) {
      if (lines[i].kind === 'text' && lines[i].text.trim() !== '' && !HOLD_RE.test(lines[i].text)) leadingBody.push(lines[i].text);
    }
    const trailingBody = [];
    for (let i = lastDescEnd + 1; i < lines.length; i++) {
      if (lines[i].kind === 'text' && lines[i].text.trim() !== '' && !HOLD_RE.test(lines[i].text)) trailingBody.push(lines[i].text);
    }
    if (leadingBody.length > 0 && trailingBody.length > 0) {
      return err('MIDDLE_PLACEMENT', '@ 提及只能出现在消息最前端或最末端，不能夹在正文中间');
    }
  }

  // 持球标记位置：不能夹在正文中间
  if (holdRows.length === 1) {
    const h = holdRows[0];
    const before = lines.slice(0, h.lineIdx).some(l => l.kind === 'text' && l.text.trim() !== '');
    const after = lines.slice(h.lineIdx + 1).some(l => l.kind === 'text' && l.text.trim() !== '');
    if (before && after) {
      return err('MIDDLE_PLACEMENT', '[持球] 只能放在消息最前端或最末端');
    }
  }

  // 组装 mentions：去重、排除自己
  const seen = new Set();
  const mentions = [];
  for (const row of agentRows) {
    for (const token of row.tokens) {
      if (currentAgent && token === currentAgent) continue; // 不能 @ 自己
      if (seen.has(token)) continue;
      seen.add(token);
      mentions.push({ agent: token, description: row.description || '' });
    }
  }

  // 每个 @ 必须带任务描述（含 @用户）
  const missing = mentions.find(m => !m.description);
  if (missing) {
    return err('MISSING_DESCRIPTION', `@${missing.agent} 缺少任务描述（任务描述应写在 @ 的下一行）`);
  }
  if (terminalRow && !terminalRow.description) {
    return err('MISSING_DESCRIPTION', '@用户 缺少说明（说明应写在 @ 的下一行）');
  }

  // 最多 @ max 个（排除自己、去重之后；@用户 不计入）
  if (mentions.length > max) {
    return err('TOO_MANY_MENTIONS', `一次最多 @ ${max} 个智能体，当前 @ 了 ${mentions.length} 个`);
  }

  // 正文：去掉 @ 行及其描述、持球标记行后剩余的非空文本
  const excluded = new Set();
  for (const row of rows) {
    for (let i = row.lineIdx; i <= row.descEndIdx; i++) excluded.add(i);
  }
  for (const h of holdRows) excluded.add(h.lineIdx);
  const bodyLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'text') continue;
    if (excluded.has(i)) continue;
    if (lines[i].text.trim() === '') continue;
    bodyLines.push(lines[i].text);
  }
  const body = bodyLines.join('\n').trim();

  return {
    mentions,
    terminal: terminalRow ? { description: terminalRow.description || '' } : null,
    hold: holdRows.length ? { reason: holdRows[0].reason } : null,
    body,
    error: null,
  };
}

module.exports = { parseMentions, buildAliasMap };
