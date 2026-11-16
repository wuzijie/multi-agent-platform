/**
 * Prompt 统一渲染器
 *
 * 所有 Agent 的 prompt 由同一个程序渲染：相同部分来自模板文件，
 * 不同部分（模型名称、模型能力、Agent 名称、可 @ 名单等）通过变量注入。
 *
 * 模板文件：src/prompt/templates/*.md，使用 {{变量}} 占位符。
 * 新增 prompt 分区只需新增一个模板文件并在对应组装函数里引用，无需改适配器。
 *
 * KV 前缀缓存约定保持不变：可变内容只出现在 instruction 尾部，
 * 头部（身份/任务/能力）与 context（团队规则/许可/承接/目标/记忆）会话内逐字节不变。
 */
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');

const TEMPLATES_DIR = path.join(__dirname, 'templates');

// model_cli → 展示名
const MODEL_LABELS = { claude: 'Claude', kimi: 'Kimi', deepseek: 'DeepSeek', qwen: 'Qwen' };

let _cache = null;

/** 加载某个目录下的模板（prefix 用于 context/ 子目录命名） */
function loadDir(dir, prefix) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const name = (prefix ? prefix + '/' : '') + f.replace(/\.md$/, '');
    _cache[name] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
}

/** 加载全部模板文件（按文件名作为模板名，缓存；含 context/ 子目录） */
function loadTemplates() {
  if (_cache) return _cache;
  _cache = {};
  if (fs.existsSync(TEMPLATES_DIR)) {
    loadDir(TEMPLATES_DIR, '');
    const ctxDir = path.join(TEMPLATES_DIR, 'context');
    if (fs.existsSync(ctxDir)) loadDir(ctxDir, 'context');
  }
  return _cache;
}

/** 渲染单个模板：替换 {{变量}}，未提供的变量原样保留 */
function render(name, vars = {}) {
  const tpl = loadTemplates()[name] || '';
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, key) => (
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : m
  ));
}

/** role → 中文标签 */
function roleLabel(role) {
  return { executor: '执行者', reviewer: '评审者', guardian: '愿景守护者' }[role] || role || '执行者';
}

/** model_cli → 展示名 */
function modelLabel(cli) {
  return MODEL_LABELS[cli] || cli || '未知';
}

/** 取某 Agent 的完整档案（config/agents.yaml），未配置时给最小档案 */
function agentProfile(agentName) {
  try {
    const cfg = config.agents || [];
    const found = cfg.find((a) => a && a.name === agentName);
    if (found) return found;
  } catch (e) { /* ignore */ }
  return { name: agentName, model_cli: '', capabilities: [], strengths: [], weaknesses: [], scenarios: [] };
}

/** 数组 → 顿号连接，空则 '—' */
function formatList(arr) {
  const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
  return list.length ? list.join('、') : '—';
}

/** 可 @ 智能体名单文本 */
function availableAgentLines(agents) {
  return (agents || []).map((a) => {
    const label = modelLabel(a.model_cli);
    return `- ${a.name}（${label}，专长：${formatList(a.strengths)}）`;
  }).join('\n');
}

/** 构建 prompt 头部：身份 + 任务ID + 要求 + 能力 */
function buildHeader(vars = {}) {
  const profile = agentProfile(vars.agentName);
  const sections = [
    render('identity', { role_label: roleLabel(vars.role), agent_name: vars.agentName }),
    render('task', { task_id: vars.taskId || '' }),
    render('requirements', {}),
    render('capabilities', {
      agent_name: vars.agentName,
      model_label: modelLabel(profile.model_cli || vars.modelCli),
      strengths: formatList(profile.strengths),
      weaknesses: formatList(profile.weaknesses),
      scenarios: formatList(profile.scenarios),
    }),
  ];
  return sections.filter((s) => s && s.trim()).join('\n\n');
}

/**
 * 构建会话级稳定上下文（ZONE A）。
 * 团队规则（含 @ 规则 + 可 @ 名单）+ 执行许可 + 承接说明 + 会话目标 + 长期记忆。
 */
function buildStableContext(vars = {}) {
  const mentionMax = Number.isFinite(vars.mentionMax) ? vars.mentionMax : 2;
  const agents = vars.availableAgents || [];
  const sections = [
    render('team_rules', {
      mention_max: mentionMax,
      available_agents: availableAgentLines(agents),
    }),
    render('permission', {}),
    render('handover', {}),
  ];
  if (vars.sessionGoal) sections.push(render('session_goal', { session_goal: vars.sessionGoal }));
  if (vars.memory && String(vars.memory).trim()) sections.push(render('memory', { memory: String(vars.memory).trim() }));
  return sections.filter((s) => s && s.trim()).join('\n\n');
}

/** 完整 prompt = 头部 + context + instruction */
function buildPrompt(vars = {}) {
  const parts = [buildHeader(vars)];
  if (vars.context && String(vars.context).trim()) parts.push(String(vars.context).trim());
  if (vars.instruction && String(vars.instruction).trim()) parts.push(String(vars.instruction).trim());
  return parts.join('\n\n');
}

/**
 * 拼接动态上下文分段（assembleIncrementalContext 产出）
 * sections = [{ title, text }]，空段落自动省略；每个非空段落渲染为 "[标题]\n正文"。
 */
function renderContextSections(sections) {
  return (sections || [])
    .filter((s) => s && s.text && String(s.text).trim())
    .map((s) => `[${s.title}]\n${String(s.text).trim()}`)
    .join('\n\n');
}

module.exports = {
  render,
  loadTemplates,
  roleLabel,
  modelLabel,
  agentProfile,
  buildHeader,
  buildStableContext,
  buildPrompt,
  renderContextSections,
};
