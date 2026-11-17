#!/usr/bin/env node
/**
 * Session 封存 / 恢复（P4）测试
 * 用假适配器，不调用真实 CLI。
 * 运行：node tests/session-handoff.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const runtime = require(path.join(ROOT, 'src/agent/runtime'));
const handoffStore = require(path.join(ROOT, 'src/utils/handoff-store'));
const cursorStore = require(path.join(ROOT, 'src/messaging/cursor-store'));
const messageLog = require(path.join(ROOT, 'src/messaging/message-log'));
const config = require(path.join(ROOT, 'src/utils/config'));
config.loadAll();

const TID = `__handoff_test_${Date.now()}`;
const AGENT = '__HandoffAgent';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const calls = [];
let nextReply = 'ok';
runtime.agents.set(AGENT, {
  name: AGENT,
  model_cli: 'claude',
  online: true,
  busy: false,
  _activeCalls: new Map(),
  adapter: {
    async execute(input) {
      calls.push(input);
      return {
        task_id: input.task_id,
        status: 'success',
        content: nextReply,
        output_files: [],
        tokens_used: 0,
        duration_ms: 1,
        session_id: 'sess-handoff-1',
      };
    },
  },
});

function makeTask(instruction) {
  return {
    task_id: TID,
    external_task_id: TID,
    role: 'executor',
    instruction,
    chat_mode: true,
    record_transcript: false,
    disableTools: true,
    stable_context: '## 稳定上下文\n团队规则',
  };
}

function cleanup() {
  try { fs.rmSync(path.join(ROOT, 'tasks', TID), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

(async () => {
  console.log('\n【Session 封存 / 恢复（P4）】');

  await test('handoff-store：封存生成五段式笔记 + capsule', async () => {
    messageLog.append(TID, { role: 'assistant', agent: AGENT, content: '完成了迁移脚本' });
    const sealed = handoffStore.seal(TID, AGENT, { reason: 'manual', cursors: { delivery_cursor: 1 } });
    assert.ok(sealed && fs.existsSync(sealed.noteFile), '笔记文件应存在');
    const note = handoffStore.latestNote(TID);
    assert.ok(note && note.content.includes('## 1. done'), '笔记应含五段式第 1 段');
    assert.ok(note.content.includes('## 5. gotchas'), '笔记应含第 5 段');
    assert.strictEqual(sealed.capsule.agent, AGENT);
    assert.strictEqual(sealed.capsule.cursors.delivery_cursor, 1);
    assert.strictEqual(handoffStore.latestCapsule(TID).reason, 'manual');
  });

  await test('[SESSION_HANDOFF] → 成功后被封存并清除 session', async () => {
    nextReply = '完成第一阶段。[SESSION_HANDOFF]';
    const r = await runtime.executeTaskWithAgent(makeTask('第一阶段'), [], AGENT);
    assert.strictEqual(r.session_sealed, 'model_request', '应标记封存原因');
    assert.ok(!String(r.content).includes('[SESSION_HANDOFF]'), '标记应从正文剥离');
    assert.strictEqual(cursorStore.get(TID, AGENT).session_id, null, 'session 应被清除');
    const note = handoffStore.latestNote(TID);
    assert.ok(note && note.content.includes('完成第一阶段'), '笔记应包含本轮输出');
  });

  await test('bootstrap：新 session 首轮注入交接笔记', async () => {
    calls.length = 0;
    nextReply = '继续第二阶段';
    await runtime.executeTaskWithAgent(makeTask('第二阶段'), [], AGENT);
    const input = calls[0];
    assert.ok(String(input.context).includes('交接笔记'), '首轮 prompt 应包含交接笔记段');
    assert.ok(String(input.context).includes('## 1. done'), '应包含笔记正文');
  });

  await test('上下文将满（阈值触发）→ 自动封存', async () => {
    const hCfg = config.context.handoff;
    const dCfg = config.context.delivery;
    const old = { ratio: hCfg.threshold_ratio, cap: dCfg.model_cap_default, chars: dCfg.chars_per_token };
    hCfg.threshold_ratio = 0.00001;
    dCfg.model_cap_default = 100;
    dCfg.chars_per_token = 1;
    try {
      nextReply = '这条回复本身没问题';
      calls.length = 0;
      const r = await runtime.executeTaskWithAgent(makeTask('阈值封存'), [], AGENT);
      assert.strictEqual(r.session_sealed, 'context_full');
      assert.strictEqual(cursorStore.get(TID, AGENT).session_id, null);
    } finally {
      hCfg.threshold_ratio = old.ratio;
      dCfg.model_cap_default = old.cap;
      dCfg.chars_per_token = old.chars;
    }
  });

  cleanup();
  console.log(`\n通过 ${passed} / ${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
