/**
 * 对话转录（prompt transcript）
 *
 * 与 conversation.md 分离：
 * - conversation.md 面向人阅读（时间戳、系统提示、格式化标题）
 * - prompt_transcript.jsonl 面向模型：只保存“实际注入 prompt 的原始片段”，
 *   下一轮原样拼接，从而保证「第 N 轮 prompt 是第 N+1 轮 prompt 的严格前缀」，
 *   最大化供应商侧 KV 前缀缓存命中。
 *
 * 文件位置：tasks/{taskId}/prompt_transcript.jsonl
 * 每行：{"content":"[用户] ..."}
 *
 * 压缩：当片段数超过 max_turns*2 或总字符超过 compact_threshold 时，
 * 一次性重写文件（保留最近 recent_turns_after_compact 轮 + 省略标记）。
 * 压缩会改变前缀，因此只在阈值触发，避免逐轮滑动窗口。
 */
const fs = require('fs');
const path = require('path');
const { historyConfig } = require('./config');
const { truncate } = require('./history');

const ROOT = path.resolve(__dirname, '..', '..');

function taskDir(taskId) {
  return path.join(ROOT, 'tasks', String(taskId));
}

function transcriptPath(taskId) {
  return path.join(taskDir(taskId), 'prompt_transcript.jsonl');
}

function ensureDir(taskId) {
  fs.mkdirSync(taskDir(taskId), { recursive: true });
}

function readEntries(taskId) {
  const fp = transcriptPath(taskId);
  if (!fs.existsSync(fp)) return [];
  try {
    return fs.readFileSync(fp, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed.content === 'string' && parsed.content.trim()
            ? { content: parsed.content }
            : null;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function writeEntries(taskId, entries) {
  ensureDir(taskId);
  const body = entries.map(e => JSON.stringify({ content: e.content })).join('\n');
  fs.writeFileSync(transcriptPath(taskId), body ? body + '\n' : '');
}

/**
 * 读取历史片段。
 * @param {string} taskId
 * @param {object} [overrides] 可覆盖 max_turns / compact_threshold 等
 * @returns {string[]}
 */
function loadSegments(taskId, overrides = {}) {
  const cfg = historyConfig(overrides);
  if (!cfg.enabled || !taskId) return [];

  let entries = readEntries(taskId);
  if (entries.length === 0) return [];

  const maxSegments = Math.max(2, Number(cfg.max_turns) * 2);
  const total = entries.reduce((sum, e) => sum + e.content.length, 0);

  // 低频压缩：片段数或字符数越界时重写一次
  if (entries.length > maxSegments || total > Number(cfg.compact_threshold)) {
    const keep = Math.max(2, Number(cfg.recent_turns_after_compact) * 2);
    const kept = entries.slice(-keep);
    const dropped = entries.length - kept.length;
    const marker = `[系统] 早前 ${dropped} 段对话已省略（会话目标见上方）`;
    entries = [{ content: marker }, ...kept];
    try { writeEntries(taskId, entries); } catch (e) { /* 压缩失败不影响本次读取 */ }
  }

  // 硬上限兜底（正常情况下压缩后远低于上限）
  const picked = [];
  let chars = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i].content;
    if (picked.length > 0 && chars + text.length > Number(cfg.max_chars)) break;
    picked.unshift(text);
    chars += text.length;
  }
  return picked;
}

/**
 * 追加片段（原样保存，不做改写，保证下次拼接与前缀一致）。
 * @param {string} taskId
 * @param {string[]} segments
 */
function appendSegments(taskId, segments) {
  if (!taskId) return;
  const list = (segments || [])
    .filter(s => typeof s === 'string' && s.trim());
  if (list.length === 0) return;
  ensureDir(taskId);
  fs.appendFileSync(
    transcriptPath(taskId),
    list.map(content => JSON.stringify({ content })).join('\n') + '\n'
  );
}

/**
 * 记录一轮完整对话（用于非聊天路径：讨论/辩论/事件驱动协作）。
 * 助手正文按 message_max_chars 截断；用户消息保持原文。
 */
function recordTurn(taskId, userMessage, agentName, assistantContent, overrides = {}) {
  const cfg = historyConfig(overrides);
  const segments = [];
  const user = String(userMessage == null ? '' : userMessage).trim();
  if (user) segments.push(`[用户] ${user}`);
  const reply = String(assistantContent == null ? '' : assistantContent).trim();
  if (reply) {
    segments.push(`[助手${agentName ? '·' + agentName : ''}] ${truncate(reply, cfg.message_max_chars)}`);
  }
  appendSegments(taskId, segments);
}

function clear(taskId) {
  try { fs.rmSync(transcriptPath(taskId), { force: true }); } catch (e) { /* ignore */ }
}

module.exports = {
  transcriptPath,
  loadSegments,
  appendSegments,
  recordTurn,
  clear,
};
