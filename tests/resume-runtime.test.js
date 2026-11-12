#!/usr/bin/env node
/**
 * Runtime × resume × 游标 集成测试（用假适配器，不调用真实 CLI）
 * 运行：node tests/resume-runtime.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const runtime = require(path.join(ROOT, 'src/agent/runtime'));
const messageLog = require(path.join(ROOT, 'src/messaging/message-log'));
const cursorStore = require(path.join(ROOT, 'src/messaging/cursor-store'));
const { validateUnifiedInput } = require(path.join(ROOT, 'src/adapters/contract/validate'));

const TID = `__resume_test_${Date.now()}`;
const AGENT = '__FakeAgent';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const calls = [];
runtime.agents.set(AGENT, {
  name: AGENT,
  model_cli: 'claude',
  online: true,
  busy: false,
  current_task: null,
  last_heartbeat: new Date().toISOString(),
  latency_ms: 0,
  _activeCalls: new Map(),
  adapter: {
    async execute(input) {
      // 用真实适配器同款校验：delta 模式 context 为空串必须通过
      validateUnifiedInput(input);
      calls.push(input);
      return {
        task_id: input.task_id,
        status: 'success',
        content: `reply-${calls.length}`,
        output_files: [],
        error: null,
        tokens_used: 0,
        duration_ms: 1,
        session_id: 'sess-fake-1',
      };
    },
  },
});

function makeTask(instruction, extra = {}) {
  return Object.assign({
    task_id: TID,
    external_task_id: TID,
    chat_mode: true,
    record_transcript: false,
    stable_context: '## 团队协作\n规则文本',
    instruction,
    role: 'executor',
  }, extra);
}

(async () => {
  console.log('\n【runtime × resume】');

  messageLog.append(TID, { role: 'user', content: '第一轮问题' });

  const r1 = await runtime.executeTaskWithAgent(makeTask('第一轮问题'), [], AGENT);
  messageLog.append(TID, { role: 'assistant', agent: AGENT, content: 'reply-1' });

  test('首次调用走 full 模式（带稳定上下文）', () => {
    assert.strictEqual(calls[0].context.includes('团队协作'), true);
  });

  test('首次调用生成并携带 session id', () => {
    assert.ok(calls[0].session && calls[0].session.id);
    assert.strictEqual(calls[0].session.is_first, true);
  });

  test('调用成功后 session 落盘', () => {
    assert.strictEqual(cursorStore.get(TID, AGENT).session_id, 'sess-fake-1');
  });

  test('首次调用携带「未授权」提示（只读）', () => {
    assert.ok(calls[0].instruction.includes('用户尚未授权'));
  });

  messageLog.append(TID, { role: 'user', content: '第二轮问题' });
  const r2 = await runtime.executeTaskWithAgent(makeTask('第二轮问题'), [], AGENT);

  test('第二轮走 delta 模式（不重复稳定上下文）', () => {
    assert.strictEqual(calls[1].context, '');
  });

  test('delta 只包含新消息，且排除自身历史', () => {
    const instr = calls[1].instruction;
    assert.ok(instr.includes('第二轮问题'));
    assert.ok(!instr.includes('reply-1'), '不应重复发送自己的历史输出');
  });

  test('第二轮复用同一 session（is_first=false）', () => {
    assert.strictEqual(calls[1].session.id, 'sess-fake-1');
    assert.strictEqual(calls[1].session.is_first, false);
  });

  test('游标随成功推进', () => {
    const cur = cursorStore.get(TID, AGENT);
    assert.ok(cur.cursor_seq >= 2);
  });

  // 会话失效：返回 SESSION_NOT_FOUND → 应清 session 并全量重试一次
  const original = runtime.agents.get(AGENT).adapter.execute;
  let n = 0;
  runtime.agents.get(AGENT).adapter.execute = async (input) => {
    n += 1;
    if (n === 1) {
      return { task_id: input.task_id, status: 'failed', content: '', error: { code: 'SESSION_NOT_FOUND', message: 'gone' }, session_id: null, duration_ms: 1 };
    }
    return original(input);
  };
  messageLog.append(TID, { role: 'user', content: '第三轮问题' });
  await runtime.executeTaskWithAgent(makeTask('第三轮问题'), [], AGENT);

  test('resume 失效后清空 session 并用 full 重试', () => {
    const last = calls[calls.length - 1];
    assert.ok(last.context.includes('团队协作'), '重试应为 full 模式');
  });

  test('授权后提示变为「已授权」', async () => {
    messageLog.append(TID, { role: 'user', content: '第四轮问题' });
    await runtime.executeTaskWithAgent(makeTask('第四轮问题', { operator_approved: true }), [], AGENT);
    const last = calls[calls.length - 1];
    assert.ok(last.instruction.includes('用户已授权'));
    assert.strictEqual(last.permission_mode, 'bypassPermissions');
  });

  try { fs.rmSync(path.join(ROOT, 'tasks', TID), { recursive: true, force: true }); } catch (e) {}
  runtime.agents.delete(AGENT);

  console.log(`\n通过 ${passed} / ${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
