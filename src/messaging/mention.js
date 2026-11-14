/**
 * 行首 @ 解析（多行）
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
 * 解析一行行首连续的 @token。
 * @returns {{tokens:string[], unknown:string[], inlineRest:string, consumed:boolean}}
 *   tokens     已识别的智能体规范名（去重，保序）
 *   unknown    第一个无法识别的 token（其后不再继续）
 *   inlineRest @token 之后同一行的剩余文本（trim 后）
 *   consumed   是否解析到至少一个 @token
 */
function parseLineMentions(trimmedLine, aliasMap) {
  const tokens = [];
  const unknown = [];
  let cursor = 0;
  let consumed = false;

  const tokenRe = /^@([^\s@]+)\s*/;
  while (true) {
    const m = trimmedLine.slice(cursor).match(tokenRe);
    if (!m) break;
    const token = m[1];
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
  return { tokens, unknown, inlineRest, consumed };
}

/**
 * @param {string} text
 * @param {object} opts
 * @param {number} opts.max              允许的最大 @ 数（去重、排除自己之后）
 * @param {Array} opts.agents            允许的 agent 列表 [{name, model_cli}]
 * @param {object} [opts.aliases]        额外别名 { 中文名: ['claude'] }
 * @param {string} [opts.currentAgent]   当前发言的 agent（模型输出时排除自己）
 * @returns {{mentions:Array<{agent:string,description:string}>, body:string, error?:{code:string,message:string}}}
 */
function parseMentions(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  const max = Number.isFinite(opts.max) ? opts.max : 2;
  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const currentAgent = opts.currentAgent || null;
  const aliasMap = buildAliasMap(agents, opts.aliases);

  const lines = splitLinesWithCode(raw);

  // 找出所有 mention 行
  const mentionRows = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'text') continue;
    const trimmed = lines[i].text.replace(/^\s+/, '');
    if (!trimmed.startsWith('@')) continue;
    const p = parseLineMentions(trimmed, aliasMap);
    if (!p.consumed) continue;
    mentionRows.push({ lineIdx: i, ...p });
  }

  if (mentionRows.length === 0) {
    return { mentions: [], body: raw.trim(), error: null };
  }

  // 未知 agent：整条拒绝（沿用旧语义）
  const firstUnknown = mentionRows.find(r => r.unknown.length > 0);
  if (firstUnknown) {
    const available = agents.map(a => a.name).join('、') || '无';
    return {
      mentions: [], body: raw.trim(),
      error: {
        code: 'UNKNOWN_AGENT',
        message: `无法识别的智能体：@${firstUnknown.unknown[0]}。可用：${available}`,
      },
    };
  }

  // 计算每个 mention 的描述范围
  for (let k = 0; k < mentionRows.length; k++) {
    const row = mentionRows[k];
    if (row.inlineRest) {
      row.description = row.inlineRest;
      row.descEndIdx = row.lineIdx; // 只占该行
      continue;
    }
    // 块描述：从 mention 行之后到下一个 mention 行 / 空行 / 结尾
    const nextMentionLine = (k + 1 < mentionRows.length) ? mentionRows[k + 1].lineIdx : lines.length;
    const descLines = [];
    let j = row.lineIdx + 1;
    let lastConsumed = row.lineIdx;
    while (j < nextMentionLine) {
      const l = lines[j];
      if (l.kind === 'code') { j++; continue; } // 跳过代码行
      if (l.text.trim() === '') break;           // 空行结束描述
      descLines.push(l.text);
      lastConsumed = j;
      j++;
    }
    row.description = descLines.join('\n').trim();
    row.descEndIdx = lastConsumed;
  }

  // 「front or end」约束：@ 块不能夹在正文中间
  const firstIdx = mentionRows[0].lineIdx;
  const lastDescEnd = Math.max(...mentionRows.map(r => r.descEndIdx));

  const leadingBody = [];
  for (let i = 0; i < firstIdx; i++) {
    if (lines[i].kind === 'text' && lines[i].text.trim() !== '') leadingBody.push(lines[i].text);
  }
  const trailingBody = [];
  for (let i = lastDescEnd + 1; i < lines.length; i++) {
    if (lines[i].kind === 'text' && lines[i].text.trim() !== '') trailingBody.push(lines[i].text);
  }

  if (leadingBody.length > 0 && trailingBody.length > 0) {
    return {
      mentions: [], body: raw.trim(),
      error: {
        code: 'MIDDLE_PLACEMENT',
        message: '@ 提及只能出现在消息最前端或最末端，不能夹在正文中间',
      },
    };
  }

  // 组装 mentions：去重、排除自己
  const seen = new Set();
  const mentions = [];
  for (const row of mentionRows) {
    for (const token of row.tokens) {
      if (currentAgent && token === currentAgent) continue; // 不能 @ 自己
      if (seen.has(token)) continue;
      seen.add(token);
      mentions.push({ agent: token, description: row.description || '' });
    }
  }

  // 每个 @ 必须带任务描述
  const missing = mentions.find(m => !m.description);
  if (missing) {
    return {
      mentions: [], body: raw.trim(),
      error: {
        code: 'MISSING_DESCRIPTION',
        message: `@${missing.agent} 缺少任务描述（任务描述应写在 @ 的下一行）`,
      },
    };
  }

  // 最多 @ max 个（排除自己、去重之后）
  if (mentions.length > max) {
    return {
      mentions: [], body: raw.trim(),
      error: {
        code: 'TOO_MANY_MENTIONS',
        message: `一次最多 @ ${max} 个智能体，当前 @ 了 ${mentions.length} 个`,
      },
    };
  }

  const body = [...leadingBody, ...trailingBody].join('\n').trim();
  return { mentions, body, error: null };
}

module.exports = { parseMentions, buildAliasMap };
