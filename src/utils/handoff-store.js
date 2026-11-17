/**
 * 交接笔记与 continuity capsule（P4：Session 封存 / 恢复）
 *
 * 产物位置：tasks/<taskId>/handoff/
 *   <agent>-<timestamp>.md    五段式交接笔记（done / worktree / commits / nextSteps / gotchas）
 *   <agent>-capsule.json      continuity capsule（A2A 链位置、球权、游标、时间）
 *
 * 用途：
 *   - CLI session 上下文接近上限、或模型输出 [SESSION_HANDOFF]、或 resume 失效时，
 *     由 runtime 调用 seal() 封存 session；下次首轮把最近一份笔记注入 prompt（bootstrap）。
 *   - 笔记为确定性生成（不额外调用模型，零成本）；模型可在正文里自行补充要点。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const messageLog = require('../messaging/message-log');

function dir(taskId) {
  return path.join(ROOT, 'tasks', String(taskId), 'handoff');
}

function ensureDir(taskId) {
  fs.mkdirSync(dir(taskId), { recursive: true });
}

function safeAgent(agent) {
  return String(agent || 'agent').replace(/[^\w一-龥.-]/g, '_');
}

function tsFileName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runGit(args, maxLines) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`git ${args}`, { cwd: ROOT, timeout: 2000, encoding: 'utf8' });
    return String(out).split('\n').map(l => l.trim()).filter(Boolean).slice(0, maxLines).join('\n') || '（无）';
  } catch (e) {
    return '（不可用）';
  }
}

/** 从消息日志提取五段式正文（确定性生成，不调用模型） */
function buildNoteBody(taskId, agent, currentContent) {
  let msgs = [];
  try { msgs = messageLog.loadAll(taskId) || []; } catch (e) { msgs = []; }

  const mine = msgs.filter(m => m.role === 'assistant' && m.agent === agent);
  const recent = mine.slice(-5);
  const done = recent.length
    ? recent.map(m => `- ${String(m.content || '').split('\n').find(l => l.trim()) || ''}`.slice(0, 160)).join('\n')
    : '-（本轮无已完成输出）';

  const last = mine.length ? String(mine[mine.length - 1].content || '') : '';
  const current = String(currentContent || '').trim();
  const nextSteps = current
    ? `本轮封存时的输出（供继续）：\n${current.slice(-500)}`
    : (last ? `最后一段输出（供继续）：\n${last.slice(-500)}` : '-（无）');
  const doneWithCurrent = current
    ? `${done}\n- ${current.split('\n').find(l => l.trim()) || ''}`.slice(0, 500)
    : done;

  const gotchas = msgs
    .filter(m => m.role === 'system' && /\[(违规转交|转交失败|持球|交还用户|召唤上限|转交阻断|阻断)\]/.test(m.content || ''))
    .slice(-8)
    .map(m => `- ${String(m.content || '').slice(0, 200)}`)
    .join('\n') || '（无）';

  return [
    `# 交接笔记（${agent}）`,
    `- 时间：${new Date().toISOString()}`,
    '',
    '## 1. done（已完成）',
    doneWithCurrent,
    '',
    '## 2. worktree（涉及文件）',
    runGit('status --short', 15),
    '',
    '## 3. commits（相关提交）',
    runGit('log --oneline -5', 5),
    '',
    '## 4. nextSteps（下一步）',
    nextSteps,
    '',
    '## 5. gotchas（注意事项）',
    gotchas,
    '',
  ].join('\n');
}

/**
 * 封存：写五段式笔记 + capsule
 * @param {string} taskId
 * @param {string} agent
 * @param {Object} [opts] { reason, task, cursors }
 * @returns {{noteFile:string, capsuleFile:string, capsule:Object}|null}
 */
function seal(taskId, agent, opts = {}) {
  if (!taskId || !agent) return null;
  ensureDir(taskId);
  const stamp = tsFileName();
  const noteFile = path.join(dir(taskId), `${safeAgent(agent)}-${stamp}.md`);
  fs.writeFileSync(noteFile, buildNoteBody(taskId, agent, opts.currentContent), 'utf8');

  const turn = (opts.task && opts.task.incremental_turn) || {};
  const capsule = {
    agent,
    reason: opts.reason || 'manual',
    created_at: new Date().toISOString(),
    a2a: {
      chain: (opts.task && Array.isArray(opts.task.trigger_chain)) ? opts.task.trigger_chain : [],
      summon_seq: turn.summonSeq || null,
      hop: turn.hop || null,
      pair_count: turn.pairCount || 0,
    },
    ball: {
      holder: agent,
      warn: !!turn.warn,
    },
    cursors: opts.cursors || {},
    workflow: null, // P3（SOP）未实现，保留字段
  };
  const capsuleFile = path.join(dir(taskId), `${safeAgent(agent)}-capsule.json`);
  fs.writeFileSync(capsuleFile, JSON.stringify(capsule, null, 2), 'utf8');
  return { noteFile, capsuleFile, capsule };
}

function listFiles(taskId, ext) {
  try {
    return fs.readdirSync(dir(taskId))
      .filter(f => f.endsWith(ext))
      .map(f => {
        const full = path.join(dir(taskId), f);
        return { file: full, name: f, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) {
    return [];
  }
}

/** 最近一份交接笔记（跨 agent，按修改时间倒序） */
function latestNote(taskId) {
  const files = listFiles(taskId, '.md');
  if (!files.length) return null;
  const top = files[0];
  const m = top.name.match(/^(.+)-\d{4}-\d{2}-\d{2}T.*\.md$/);
  let content = '';
  try { content = fs.readFileSync(top.file, 'utf8'); } catch (e) { return null; }
  return { file: top.file, agent: m ? m[1] : null, content };
}

/** 最近一份 capsule */
function latestCapsule(taskId) {
  const files = listFiles(taskId, '.json').filter(f => /-capsule\.json$/.test(f.name));
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(files[0].file, 'utf8')); } catch (e) { return null; }
}

module.exports = {
  dir,
  seal,
  latestNote,
  latestCapsule,
  buildNoteBody,
  listNotes: (taskId) => listFiles(taskId, '.md'),
};
