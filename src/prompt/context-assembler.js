/**
 * 动态上下文组装（assembleIncrementalContext）
 *
 * 被 @ 的 agent 收到的不再是一句任务描述，而是一份六段式增量上下文：
 *
 *   [来源标识] A 的完整回复来自谁、模型是什么
 *   [模式声明] 你是第 N 只被召唤的 agent（串行接力）
 *   [导航头]   接力棒 + 活跃任务 + 最近修改文件
 *   [触发消息原文] A 的完整回复（含 @ 与任务描述）
 *   [未读历史] delivery_cursor 之后的未读消息（Warm 展开 / Cold 简报）
 *   [系统提示] 传球决策树 + 队友花名册 + 协作格式 + 球权检查
 *   [乒乓警告] 与 A 来回 ≥ warn_threshold 时条件注入
 *
 * 本模块为纯函数（不读文件、不调模型）：未读消息、花名册、预算均由调用方传入，
 * 便于单测与替换数据源。Cold Path 默认走确定性简报（零模型成本）。
 *
 * 配置：config/context.yaml → context.delivery
 */
const renderer = require('./renderer');
const config = require('../utils/config');

const DELIVERY_DEFAULTS = {
  warmMaxMsgs: 12,
  warmMaxChars: 12000,
  coldBriefMaxChars: 2500,
  coldUseLlm: false,
  budgetRatio: 0.5,
  modelCap: 128000,      // 模型输入 token 上限（未知时兜底）
  charsPerToken: 2,      // 中文保守估算
  triggerHeadChars: 4000,
  triggerTailChars: 2000,
};

/** 读取 context.delivery 配置（每次调用现读，便于运行中调整） */
function deliveryConfig() {
  const d = (config.context && config.context.delivery) || {};
  const num = (v, dflt) => (Number.isFinite(Number(v)) && v !== null && v !== '') ? Number(v) : dflt;
  return {
    warmMaxMsgs: num(d.warm_max_msgs, DELIVERY_DEFAULTS.warmMaxMsgs),
    warmMaxChars: num(d.warm_max_chars, DELIVERY_DEFAULTS.warmMaxChars),
    coldBriefMaxChars: num(d.cold_brief_max_chars, DELIVERY_DEFAULTS.coldBriefMaxChars),
    coldUseLlm: !!d.cold_use_llm,
    budgetRatio: num(d.budget_ratio, DELIVERY_DEFAULTS.budgetRatio),
    modelCap: num(d.model_cap_default, DELIVERY_DEFAULTS.modelCap),
    charsPerToken: num(d.chars_per_token, DELIVERY_DEFAULTS.charsPerToken),
    triggerHeadChars: num(d.trigger_head_chars, DELIVERY_DEFAULTS.triggerHeadChars),
    triggerTailChars: num(d.trigger_tail_chars, DELIVERY_DEFAULTS.triggerTailChars),
  };
}

/** 列表 → 顿号连接（限量 8 个），空则 fallback */
function fmtList(items, fallback) {
  const list = (Array.isArray(items) ? items : [items])
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean);
  return list.length ? list.slice(0, 8).join('、') : fallback;
}

/** 消息发送者标签 */
function senderLabel(m) {
  if (m.role === 'user') return m.agent ? `${m.agent}（转交提问）` : '用户';
  return m.agent || '助手';
}

/** 取内容中第一行有意义文本（跳过 @ 行与空行），用于简报/时间线 */
function firstMeaningfulLine(content, max = 160) {
  const lines = String(content == null ? '' : content)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('@'));
  const first = lines[0] || '';
  return first.length > max ? first.slice(0, max) + '…' : first;
}

/** 触发消息原文头尾截断 */
function truncateTrigger(text, head, tail) {
  const s = String(text == null ? '' : text);
  if (s.length <= head + tail) return s;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n…（触发消息过长，中间省略 ${omitted} 字符）…\n${s.slice(-tail)}`;
}

/** 该消息是否 @ 了目标 agent（行首 @） */
function isAtYou(content, targetAgent) {
  if (!targetAgent) return false;
  const esc = String(targetAgent).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*@${esc}(?:\\s|$|@)`, 'm').test(String(content == null ? '' : content));
}

/** Warm Path：逐条展开未读消息 */
function formatUnreadWarm(unread, targetAgent) {
  return unread.map((m) => {
    const tags = [];
    if (isAtYou(m.content, targetAgent)) tags.push('@你');
    if (m.kind === 'whisper') tags.push('私语');
    const head = `[#${m.seq} ${senderLabel(m)}${tags.length ? '（' + tags.join('/') + '）' : ''}]`;
    return head + '\n' + String(m.content);
  }).join('\n\n');
}

/** 收集未读中的 @ 关系（行首 @ + 下一行描述） */
function collectAtRelations(unread) {
  const relations = [];
  for (const m of unread) {
    const lines = String(m.content == null ? '' : m.content).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const mt = lines[i].match(/^\s*@([^\s@]+)\s*$/);
      if (!mt) continue;
      const desc = (lines[i + 1] || '').trim().slice(0, 80);
      relations.push(`#${m.seq} ${senderLabel(m)} @${mt[1]}${desc ? '：' + desc : ''}`);
    }
  }
  return relations;
}

/**
 * Cold Path：确定性简报（不调用模型）
 * 结构：参与者归纳 + @ 关系 + 时间线（从最旧丢弃，保最新）
 */
function formatUnreadCold(unread, maxChars) {
  const byWho = new Map();
  for (const m of unread) {
    const who = senderLabel(m);
    const rec = byWho.get(who) || { count: 0, last: null };
    rec.count += 1;
    rec.last = m;
    byWho.set(who, rec);
  }

  const participantLines = Array.from(byWho.entries()).map(([who, r]) => (
    `- ${who}：${r.count} 条；最后发言 #${r.last.seq}：${firstMeaningfulLine(r.last.content, 160)}`
  ));

  const relations = collectAtRelations(unread).slice(-10);
  const relationLines = relations.length ? ['@ 关系：', ...relations.map((r) => `  ${r}`)] : [];

  const header = [`【未读简报】共 ${unread.length} 条消息`, ...participantLines, ...relationLines].join('\n');

  // 时间线：从最新向最旧填充，剩余空间留给最旧丢弃说明
  const timeline = [];
  let used = header.length;
  for (let i = unread.length - 1; i >= 0; i--) {
    const m = unread[i];
    const line = `#${m.seq} ${senderLabel(m)}：${firstMeaningfulLine(m.content, 120)}`;
    if (used + line.length + 1 > maxChars && timeline.length > 0) {
      timeline.unshift(`…（更早的 ${i + 1} 条消息省略）`);
      break;
    }
    used += line.length + 1;
    timeline.unshift(line);
  }

  const body = [header, '', '时间线（摘要）：', ...timeline].join('\n');
  return body.length > maxChars
    ? body.slice(0, maxChars) + '\n…（简报已截断）'
    : body;
}

/**
 * 从最新向最老保留未读消息，超预算时丢弃最旧
 * @returns {{kept: Array, dropped: number}} dropped = 被丢弃的最旧消息条数
 */
function trimOldest(unread, budgetChars) {
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (let i = unread.length - 1; i >= 0; i--) {
    const cost = String(unread[i].content == null ? '' : unread[i].content).length + 60;
    if (kept.length > 0 && used + cost > budgetChars) {
      dropped = i + 1; // 0..i 这些更旧的消息全部丢弃
      break;
    }
    used += cost;
    kept.unshift(unread[i]);
  }
  return { kept, dropped };
}

/** 队友花名册文本 */
function formatRoster(roster) {
  return (roster || []).map((r) => {
    const bits = [];
    if (r.model_cli) bits.push(renderer.modelLabel(r.model_cli));
    if (Array.isArray(r.strengths) && r.strengths.length) bits.push('专长：' + r.strengths.join('、'));
    bits.push(r.online === false ? '离线' : (r.busy ? '忙碌' : '空闲'));
    return `- ${r.name}（${bits.join('；')}）`;
  }).join('\n') || '（无可用队友）';
}

/** 可用预算：模型输入上限扣除固定段落与输出预留后，分配给未读历史 */
function computeUnreadBudget(d, fixedChars, maxTokens) {
  const capChars = d.modelCap * d.charsPerToken;
  const usableChars = Math.max(3000, Math.floor(capChars * d.budgetRatio));
  const outputReserve = (Number(maxTokens) || 4096) * d.charsPerToken;
  return Math.max(1500, usableChars - fixedChars - outputReserve);
}

/**
 * 未读历史段：Warm 逐条展开 / Cold 确定性简报；超预算从最旧丢弃
 * @returns {{text:string, dropped:number, isWarm:boolean}}
 */
function buildUnreadSection(unread, targetAgent, d, budgetChars) {
  const totalChars = unread.reduce((s, m) => s + String(m.content == null ? '' : m.content).length, 0);
  const isWarm = unread.length <= d.warmMaxMsgs && totalChars <= d.warmMaxChars;
  let text = '';
  let dropped = 0;
  if (unread.length === 0) {
    text = '（无新消息）';
  } else if (isWarm) {
    const trimmed = trimOldest(unread, budgetChars);
    dropped = trimmed.dropped;
    text = formatUnreadWarm(trimmed.kept, targetAgent);
    if (dropped > 0) text += `\n\n（更早的 ${dropped} 条消息因预算省略）`;
  } else {
    text = formatUnreadCold(unread, Math.min(d.coldBriefMaxChars, budgetChars));
  }
  return { text, dropped, isWarm };
}

/**
 * 组装被 @ agent 的增量上下文
 *
 * @param {Object} p
 * @param {string} p.targetAgent      被 @ 的 agent（B）
 * @param {string} [p.fromAgent]      触发者（A；缺省按"用户"处理）
 * @param {string} [p.triggerModel]   触发者模型展示名
 * @param {string} [p.triggerContent] A 的完整回复（含 @mention 行）
 * @param {string} [p.mentionDesc]    @ 行下写的任务描述
 * @param {Array}  [p.unread]         delivery_cursor 之后的未读消息（调用方用 messageLog.unread 取）
 * @param {Array}  [p.roster]         队友花名册 [{name, model_cli, strengths, busy, online}]
 * @param {Array}  [p.activeTasks]    活跃任务摘要（字符串数组）
 * @param {Array}  [p.recentFiles]    最近修改文件（字符串数组）
 * @param {Object} [p.turn]           { summonSeq, hop, chain, pairCount, warn, modeLabel }
 * @param {string} [p.extraHistory]   转录历史（history_segments 拼串；增量上下文替换历史区时并入）
 * @param {number} [p.maxTokens]      预留输出 tokens
 * @returns {{sections: Array<{title:string,text:string}>, prompt: string, stats: Object}}
 */
function assembleIncrementalContext(p = {}) {
  const d = deliveryConfig();
  const unread = Array.isArray(p.unread) ? p.unread : [];
  const targetAgent = p.targetAgent || '';
  const fromAgent = p.fromAgent || '用户';
  const turn = p.turn || {};
  const warn = !!turn.warn;
  const pairCount = Number(turn.pairCount) || 0;

  // ===== resume delta 模式：CLI 已保存前轮上下文，只发增量 =====
  // 内容 = [未读历史] + [本轮指令] + [乒乓警告]（条件）；
  // 模式声明/导航头/系统提示/固定规则等首轮已发过，不再重复。
  if (p.delta) {
    const instrText = String(p.instruction || '').trim();
    const warnText = warn ? renderer.render('context/pingpong_warn', {
      from_agent: fromAgent,
      pair_count: pairCount,
      warn_threshold: Number(turn.warnThreshold) || 2,
      block_threshold: Number(turn.blockThreshold) || 4,
    }) : '';
    const fixedChars = instrText.length + warnText.length + 40;
    const budgetChars = computeUnreadBudget(d, fixedChars, p.maxTokens);
    const u = buildUnreadSection(unread, targetAgent, d, budgetChars);
    const sections = [
      { title: '未读历史', text: u.text },
      { title: '本轮指令', text: instrText || '（见未读历史）' },
    ];
    if (warnText) sections.push({ title: '乒乓警告', text: warnText });
    return {
      sections,
      prompt: renderer.renderContextSections(sections),
      stats: {
        mode: 'delta',
        path: u.isWarm ? 'warm' : 'cold',
        unread_count: unread.length,
        unread_chars: u.text.length,
        dropped_msgs: u.dropped,
        trimmed: u.dropped > 0,
        budget_chars: budgetChars,
        pair_count: pairCount,
        warn,
      },
    };
  }

  // ===== 非未读段落（先构建，用于计算剩余预算）=====
  const sourceSec = {
    title: '来源标识',
    text: renderer.render('context/source', { from_agent: fromAgent, model: p.triggerModel || '' }),
  };
  const modeSec = {
    title: '模式声明',
    text: renderer.render('context/summon_mode', {
      summon_seq: turn.summonSeq || 1,
      mode_label: turn.modeLabel || '串行接力模式',
    }),
  };
  const navSec = {
    title: '导航头',
    text: renderer.render('context/navigation', {
      from_agent: fromAgent,
      hop: turn.hop || 1,
      chain: (Array.isArray(turn.chain) && turn.chain.length ? turn.chain : ['用户']).join(' → '),
      active_tasks: fmtList(p.activeTasks, '无'),
      recent_files: fmtList(p.recentFiles, '无'),
    }),
  };
  const triggerSec = {
    title: '触发消息原文',
    text: renderer.render('context/trigger', {
      from_agent: fromAgent,
      mention_desc: p.mentionDesc || '（未提供任务描述）',
      trigger_content: truncateTrigger(p.triggerContent || '', d.triggerHeadChars, d.triggerTailChars),
    }),
  };
  const systemSec = {
    title: '系统提示',
    text: [
      renderer.render('context/pass_decision', {}),
      renderer.render('context/roster', { roster_lines: formatRoster(p.roster) }),
      renderer.render('context/collab_format', {}),
      renderer.render('context/ball_check', {
        summon_seq: turn.summonSeq || 1,
        from_agent: fromAgent,
        pair_count: pairCount,
      }),
    ].filter((s) => s && s.trim()).join('\n'),
  };
  const warnSec = warn ? {
    title: '乒乓警告',
    text: renderer.render('context/pingpong_warn', {
      from_agent: fromAgent,
      pair_count: pairCount,
      warn_threshold: Number(turn.warnThreshold) || 2,
      block_threshold: Number(turn.blockThreshold) || 4,
    }),
  } : null;

  // ===== 预算：模型输入上限扣除固定段落与输出预留，剩余给未读历史 =====
  const fixedChars = [sourceSec, modeSec, navSec, triggerSec, systemSec, warnSec]
    .filter(Boolean)
    .reduce((s, x) => s + x.title.length + x.text.length + 4, 0);
  const unreadBudget = computeUnreadBudget(d, fixedChars, p.maxTokens);

  // ===== Warm / Cold 判定 + 预算裁剪 =====
  const u = buildUnreadSection(unread, targetAgent, d, unreadBudget);
  const unreadText = u.text;
  const dropped = u.dropped;
  const isWarm = u.isWarm;

  const unreadSec = {
    title: '未读历史',
    text: unreadText,
  };

  // 转录历史（history_segments）：增量上下文替换了运行时默认的历史区，
  // 若调用方另有转录历史（讨论/DAG 等），并入未读历史之后，避免上下文断裂。
  const extraSec = (p.extraHistory && String(p.extraHistory).trim()) ? {
    title: '转录历史',
    text: String(p.extraHistory).trim(),
  } : null;

  const sections = [sourceSec, modeSec, navSec, triggerSec, unreadSec];
  if (extraSec) sections.push(extraSec);
  sections.push(systemSec);
  if (warnSec) sections.push(warnSec);

  const prompt = renderer.renderContextSections(sections);

  return {
    sections,
    prompt,
    stats: {
      path: isWarm ? 'warm' : 'cold',
      unread_count: unread.length,
      unread_chars: unreadText.length,
      dropped_msgs: dropped,
      trimmed: dropped > 0,
      budget_chars: unreadBudget,
      pair_count: pairCount,
      warn,
    },
  };
}

module.exports = {
  assembleIncrementalContext,
  deliveryConfig,
  formatUnreadWarm,
  formatUnreadCold,
  trimOldest,
  truncateTrigger,
  formatRoster,
};
