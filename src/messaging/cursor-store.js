/**
 * 每个 Agent（不是每个 CLI）的进度标志位与会话状态
 *
 * 文件：tasks/{taskId}/cli_state/{agent}.json
 *
 * 关键字段：
 *   cursor_seq     该 Agent 的 CLI 已消费到的最后一条消息 seq（resume 增量用）
 *   delivery_cursor 投递游标：该 Agent 已收到过的最大消息 seq（动态上下文投递用）
 *   pingpong       本对话内与其他 agent 的往返计数（pairKey → 次数，可选持久化）
 *   session_id     用于 --resume 的会话 id
 *   profile_version 由 cli/model/规则版本计算；变化即作废 session
 *
 * cursor_seq 与 delivery_cursor 分开的原因：前者服务 resume delta，
 * session 失效时会清零重放；后者服务「投递了哪些消息」的语义，
 * 即使走全量注入也不应把已投递消息当未读重复轰炸。
 *
 * 为什么按 agent 而不是按 CLI：迪普斯克与钱文共用同一个 qwen 可执行文件，
 * 但模型不同，session 必须互相隔离。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

function stateDir(taskId) {
  return path.join(ROOT, 'tasks', String(taskId), 'cli_state');
}

function statePath(taskId, agent) {
  return path.join(stateDir(taskId), `${encodeURIComponent(agent)}.json`);
}

function defaults(agent, extra = {}) {
  return {
    agent,
    cli: extra.cli || null,
    model: extra.model || null,
    cursor_seq: 0,
    delivery_cursor: 0,
    pingpong: {},
    session_id: null,
    profile_version: extra.profile_version || null,
    last_prompt_seq: 0,
    last_ok_at: null,
    last_error: null,
    updated_at: null,
  };
}

function get(taskId, agent) {
  const fp = statePath(taskId, agent);
  if (!fs.existsSync(fp)) return defaults(agent);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Object.assign(defaults(agent), raw);
  } catch (e) {
    return defaults(agent);
  }
}

function save(taskId, agent, state) {
  fs.mkdirSync(stateDir(taskId), { recursive: true });
  const fp = statePath(taskId, agent);
  const tmp = `${fp}.tmp`;
  const body = JSON.stringify(Object.assign({}, state, {
    agent,
    updated_at: new Date().toISOString(),
  }), null, 2);
  // 原子写：先写临时文件再 rename，避免读到半截 JSON
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, fp);
  return state;
}

function update(taskId, agent, patch) {
  const next = Object.assign(get(taskId, agent), patch);
  return save(taskId, agent, next);
}

/** 推进游标（不回退） */
function advanceCursor(taskId, agent, seq) {
  const cur = get(taskId, agent);
  if (!seq || seq <= cur.cursor_seq) return cur;
  return update(taskId, agent, { cursor_seq: seq, last_ok_at: new Date().toISOString() });
}

/** 推进投递游标（不回退）：仅在一次调用成功/取消后由调用方推进 */
function advanceDeliveryCursor(taskId, agent, seq) {
  const cur = get(taskId, agent);
  if (!seq || seq <= cur.delivery_cursor) return cur;
  return update(taskId, agent, { delivery_cursor: seq, last_ok_at: new Date().toISOString() });
}

function setSession(taskId, agent, sessionId, profileVersion) {
  return update(taskId, agent, {
    session_id: sessionId || null,
    profile_version: profileVersion || null,
  });
}

/** 会话失效：清空 session，不改游标（由调用方决定是否回滚） */
function clearSession(taskId, agent, error) {
  return update(taskId, agent, {
    session_id: null,
    last_error: error || null,
  });
}

function resetCursor(taskId, agent) {
  return update(taskId, agent, { cursor_seq: 0, last_prompt_seq: 0 });
}

/** profile 指纹：CLI / 模型 / 规则版本变化时作废旧会话 */
function profileVersion(parts) {
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify(parts || {}));
  return h.digest('hex').slice(0, 16);
}

module.exports = {
  statePath,
  get,
  save,
  update,
  advanceCursor,
  advanceDeliveryCursor,
  setSession,
  clearSession,
  resetCursor,
  profileVersion,
};
