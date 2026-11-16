/**
 * 动态上下文通用入口（所有调用场景共用）
 *
 * 采集未读消息 / 投递游标 / 队友花名册 / 活跃任务 / 最近修改文件，
 * 然后交给 context-assembler 组装六段式增量上下文。
 *
 * 应用场景（通用）：
 *   - 聊天直呼：用户 @ agent 或无 @ 的普通对话
 *   - agent 转交链：A 回复中 @ B（携带接力链与乒乓计数）
 *   - 讨论模式 / 三类协作模式：每次内部调用
 *   - DAG 子任务与规划：调度器派发的每次模型调用
 * 调用方也可以显式传 task.incremental_context 覆盖自动组装；
 * 后台维护类调用（如记忆摘要）可用 task.skip_incremental_context = true 跳过。
 */
const path = require('path');
const { assembleIncrementalContext } = require('./context-assembler');
const messageLog = require('../messaging/message-log');
const cursorStore = require('../messaging/cursor-store');
const renderer = require('./renderer');

const ROOT = path.resolve(__dirname, '..', '..');

// 最近修改文件采样缓存（30s TTL，避免每次调用都跑 git status）
let _recentCache = { at: 0, files: [] };
const RECENT_TTL_MS = 30000;

/** 队友花名册快照 [{name, model_cli, strengths, busy, online}] */
function rosterSnapshot(agentRuntime) {
  try {
    const { enabledAgents } = require('../utils/agent-list');
    return enabledAgents().map((a) => {
      const st = agentRuntime && agentRuntime.getAgentState ? agentRuntime.getAgentState(a.name) : null;
      return {
        name: a.name,
        model_cli: a.model_cli,
        strengths: a.strengths || [],
        busy: !!(st && st.busy),
        online: st ? !!st.online : true,
      };
    });
  } catch (e) {
    return [];
  }
}

/** 活跃任务快照（调度器中未完成的协作 trace） */
function activeTasksSnapshot() {
  try {
    const scheduler = require('../engine/scheduler');
    const pending = (scheduler && scheduler._pending) ? Array.from(scheduler._pending.keys()) : [];
    return pending.slice(0, 5).map((tid) => `协作 trace ${tid}`);
  } catch (e) {
    return [];
  }
}

/** 最近修改文件（git status --short 限量，30s 缓存） */
function recentFilesSnapshot() {
  const now = Date.now();
  if (now - _recentCache.at < RECENT_TTL_MS) return _recentCache.files;
  let files = [];
  try {
    const { execSync } = require('child_process');
    const out = execSync('git status --short', { cwd: ROOT, timeout: 2000, encoding: 'utf8' });
    files = String(out).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10);
  } catch (e) {
    files = [];
  }
  _recentCache = { at: now, files };
  return files;
}

/** agent → 模型展示名（来源标识用） */
function agentModelLabel(agentName) {
  try {
    const profile = renderer.agentProfile(agentName);
    return renderer.modelLabel(profile.model_cli || '');
  } catch (e) {
    return '';
  }
}

/**
 * 构建某 agent 本次调用的增量上下文
 *
 * @param {Object} p
 * @param {Object} p.task          任务/调用描述（取 external_task_id/task_id 作为会话键）
 * @param {string} p.agentName     目标 agent
 * @param {Object} [p.agentRuntime] AgentRuntime（花名册忙闲状态）
 * @param {string} [p.fromAgent]   触发者（缺省「用户」）
 * @param {string} [p.triggerContent] 触发消息原文（缺省取 task.instruction）
 * @param {string} [p.mentionDesc] 任务描述
 * @param {Array}  [p.chain]       接力链
 * @param {Object} [p.turn]        乒乓/召唤上下文（可选）
 * @param {string} [p.extraHistory] 转录历史（history_segments 拼串，可选）
 * @returns {{prompt:string, stats:Object, deliveredUpTo:number, ctxTaskId:string, deliveryCursor:number}}
 */
function buildIncrementalContext(p = {}) {
  const task = p.task || {};
  const agentName = p.agentName || '';
  const ctxTaskId = task.external_task_id || task.task_id || '';
  const deliveryCursor = (ctxTaskId && agentName)
    ? (cursorStore.get(ctxTaskId, agentName).delivery_cursor || 0)
    : 0;
  const unread = ctxTaskId ? messageLog.unread(ctxTaskId, { cursorSeq: deliveryCursor, agent: agentName }) : [];
  const deliveredUpTo = unread.length ? unread[unread.length - 1].seq : deliveryCursor;

  const fromAgent = p.fromAgent || '用户';
  const chain = (Array.isArray(p.chain) && p.chain.length)
    ? p.chain
    : ['用户', ...(fromAgent !== '用户' ? [fromAgent] : [])];

  const res = assembleIncrementalContext({
    targetAgent: agentName,
    fromAgent,
    triggerModel: agentModelLabel(fromAgent),
    triggerContent: p.triggerContent || task.instruction || task.description || '',
    mentionDesc: p.mentionDesc || '',
    unread,
    roster: rosterSnapshot(p.agentRuntime),
    activeTasks: activeTasksSnapshot(),
    recentFiles: recentFilesSnapshot(),
    turn: p.turn ? Object.assign({ chain }, p.turn) : { summonSeq: 1, hop: 1, chain },
    extraHistory: p.extraHistory || '',
    maxTokens: task.max_tokens,
  });

  return {
    prompt: res.prompt,
    stats: res.stats,
    deliveredUpTo,
    ctxTaskId,
    deliveryCursor,
  };
}

module.exports = {
  buildIncrementalContext,
  rosterSnapshot,
  activeTasksSnapshot,
  recentFilesSnapshot,
  agentModelLabel,
};
