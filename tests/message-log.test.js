#!/usr/bin/env node
/**
 * 消息日志 + 游标 + resume 参数构造测试
 * 运行：node tests/message-log.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const messageLog = require(path.join(ROOT, 'src/messaging/message-log'));
const cursorStore = require(path.join(ROOT, 'src/messaging/cursor-store'));
const capabilities = require(path.join(ROOT, 'src/adapters/contract/capabilities'));

const TID = `__test_task_${Date.now()}`;
const TID2 = `${TID}_backfill`;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}
function cleanup(id) {
  try { fs.rmSync(path.join(ROOT, 'tasks', id), { recursive: true, force: true }); } catch (e) {}
}

console.log('\n【消息日志 messages.jsonl】');

test('append 分配单调 seq', () => {
  const s1 = messageLog.append(TID, { role: 'user', content: 'hello' });
  const s2 = messageLog.append(TID, { role: 'assistant', agent: '克劳德', content: 'hi' });
  assert.strictEqual(s1, 1);
  assert.strictEqual(s2, 2);
});

test('system 消息不入 prompt（since 默认过滤）', () => {
  messageLog.append(TID, { role: 'system', content: '系统提示' });
  const list = messageLog.since(TID, 0);
  assert.strictEqual(list.length, 2);
  assert.ok(list.every(m => m.role !== 'system'));
});

test('since 只返回游标之后', () => {
  const list = messageLog.since(TID, 2);
  assert.strictEqual(list.length, 0);
  messageLog.append(TID, { role: 'user', content: 'third' });
  assert.strictEqual(messageLog.since(TID, 2).length, 1);
});

test('excludeAgent 排除自身输出', () => {
  const list = messageLog.since(TID, 0, { excludeAgent: '克劳德' });
  assert.ok(list.every(m => !(m.role === 'assistant' && m.agent === '克劳德')));
});

test('latestAssistantAgent 取最后回复者', () => {
  messageLog.append(TID, { role: 'assistant', agent: '钱文', content: 'answer' });
  assert.strictEqual(messageLog.latestAssistantAgent(TID), '钱文');
});

test('backfillFromConversation 可从 conversation.md 回填', () => {
  fs.mkdirSync(path.join(ROOT, 'tasks', TID2), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tasks', TID2, 'conversation.md'), [
    '### 🧑 用户 - 2026-01-01T00:00:00Z',
    '',
    '你好',
    '',
    '---',
    '### 🤖 助手 - 2026-01-01T00:00:01Z',
    '',
    '**克劳德**',
    '',
    '你好，我是克劳德',
    '',
    '---',
    '### ⚙️ 系统 - 2026-01-01T00:00:02Z',
    '',
    '系统提示',
    '',
    '---',
  ].join('\n'));
  const n = messageLog.backfillFromConversation(TID2);
  assert.strictEqual(n, 3);
  const all = messageLog.loadAll(TID2);
  assert.strictEqual(all[0].role, 'user');
  assert.strictEqual(all[2].role, 'system');
});

console.log('\n【游标 cli_state】');

test('cursor 默认 0、session 空', () => {
  const st = cursorStore.get(TID, '克劳德');
  assert.strictEqual(st.cursor_seq, 0);
  assert.strictEqual(st.session_id, null);
});

test('advanceCursor 只前进不回退', () => {
  cursorStore.advanceCursor(TID, '克劳德', 5);
  cursorStore.advanceCursor(TID, '克劳德', 3);
  assert.strictEqual(cursorStore.get(TID, '克劳德').cursor_seq, 5);
});

test('setSession / clearSession', () => {
  cursorStore.setSession(TID, '克劳德', 'sess-1', 'pv1');
  assert.strictEqual(cursorStore.get(TID, '克劳德').session_id, 'sess-1');
  cursorStore.clearSession(TID, '克劳德', 'expired');
  assert.strictEqual(cursorStore.get(TID, '克劳德').session_id, null);
});

test('不同 agent 的游标互相隔离', () => {
  cursorStore.advanceCursor(TID, '钱文', 7);
  assert.strictEqual(cursorStore.get(TID, '钱文').cursor_seq, 7);
  assert.strictEqual(cursorStore.get(TID, '克劳德').cursor_seq, 5);
});

console.log('\n【resume 参数构造】');

test('claude 首次调用使用 --session-id', () => {
  const args = capabilities.buildResumeArgs('claude', { sessionId: 'abc', isFirstCall: true });
  assert.deepStrictEqual(args, ['--session-id', 'abc']);
});

test('claude 后续调用使用 --resume', () => {
  const args = capabilities.buildResumeArgs('claude', { sessionId: 'abc', isFirstCall: false });
  assert.deepStrictEqual(args, ['--resume', 'abc']);
});

test('deepseek 继承 qwen 的 resume 模板', () => {
  const q = capabilities.buildResumeArgs('qwen', { sessionId: 'x', isFirstCall: false });
  const d = capabilities.buildResumeArgs('deepseek', { sessionId: 'x', isFirstCall: false });
  assert.deepStrictEqual(d, q);
});

cleanup(TID);
cleanup(TID2);
console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
