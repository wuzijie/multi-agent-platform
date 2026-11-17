#!/usr/bin/env node
/**
 * 交接行为测试（P1）：三选一分派与防循环增强
 * 用假 _streamedExecute，不调用真实 CLI。
 * 运行：node tests/handoff.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const orchestrator = require(path.join(ROOT, 'src/orchestrator/orchestrator'));
const messageLog = require(path.join(ROOT, 'src/messaging/message-log'));
const config = require(path.join(ROOT, 'src/utils/config'));
config.loadAll();

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const created = [];

async function newTask(name) {
  const t = await orchestrator.createTask({ name, description: name });
  created.push(t.task_id);
  return t.task_id;
}

function stubAgent(responses) {
  const calls = [];
  orchestrator._streamedExecute = async (task, taskId, agentName) => {
    calls.push({ agent: agentName, instruction: task.instruction });
    const content = typeof responses === 'function' ? responses(agentName, calls.length) : responses[agentName];
    return { task_id: taskId, status: 'success', content: content || '', output_files: [], duration_ms: 1 };
  };
  return calls;
}

(async () => {
  console.log('\n【交接三选一（P1）】');

  await test('[持球] → 不派发其他 agent，记录持球', async () => {
    const tid = await newTask('持球等待');
    const calls = stubAgent({ 克劳德: '分析完成，等 CI 结果。\n\n[持球:等待 CI]' });
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 出方案', '出方案', ['克劳德']);
    assert.strictEqual(calls.length, 1, '不应拉起其他 agent');
    const conv = orchestrator.getConversation(tid);
    assert.ok(conv.includes('[持球]'), '会话应记录持球状态');
    const holds = messageLog.loadAll(tid).filter(m => m.kind === 'hold');
    assert.ok(holds.length >= 1, 'messages.jsonl 应有 kind=hold 记录');
  });

  await test('@用户 → 交还用户，链终止', async () => {
    const tid = await newTask('交还用户');
    const calls = stubAgent({ 克劳德: '@用户\n需要你确认是否 force push' });
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 处理发布', '处理发布', ['克劳德']);
    assert.strictEqual(calls.length, 1, '@用户 不应 spawn 任何 agent');
    assert.ok(orchestrator.getConversation(tid).includes('[交还用户]'));
    assert.ok(orchestrator.getConversation(tid).includes('force push'));
  });

  await test('并行模式：多个 agent 独立作答时 @ 无路由语义', async () => {
    const tid = await newTask('并行忽略@');
    const calls = stubAgent((agent) => (
      agent === '克劳德' ? '我认为可行。\n\n@钱文\n补充中文说明' : '迪普斯克的回答'
    ));
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 @迪普斯克 同一问题', '同一问题', ['克劳德', '迪普斯克']);
    assert.strictEqual(calls.length, 2, '并行轮不应因 @ 再拉起第三个 agent');
    const conv = orchestrator.getConversation(tid);
    assert.ok(conv.includes('[并行模式]'), '应有并行模式忽略提示');
  });

  await test('球权死锁措辞 → 提示未交接（不阻断）', async () => {
    const tid = await newTask('死锁提示');
    const calls = stubAgent({ 克劳德: '这个问题我先记下，稍后处理。' });
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 看下', '看下', ['克劳德']);
    assert.strictEqual(calls.length, 1);
    assert.ok(orchestrator.getConversation(tid).includes('球权未转移'));
  });

  await test('实质工作重置乒乓：不触发乒乓阻断（受召唤上限/深度约束）', async () => {
    const tid = await newTask('实质工作重置');
    const big = 'x'.repeat(300);
    const calls = stubAgent((agent) => {
      const other = agent === '克劳德' ? '迪普斯克' : '克劳德';
      return `${big}\n\n@${other}\n继续推进`;
    });
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 开始', '开始', ['克劳德']);
    // 每轮都有 >200 字实质工作 → 乒乓计数被重置，不会触发 2/4 阻断；
    // 最终由 summon_max_per_agent=4 兜底：A/B 各 4 次，共 8 次调用后阻断
    assert.strictEqual(calls.length, 8, `应在召唤上限处停止（实际 ${calls.length} 次）`);
    const conv = orchestrator.getConversation(tid);
    assert.ok(!conv.includes('[转交阻断]'), '实质工作重置后不应触发乒乓阻断');
    assert.ok(conv.includes('[召唤上限]'), '应触发单 agent 召唤上限兜底');
  });

  for (const id of created) {
    try { fs.rmSync(path.join(ROOT, 'tasks', id), { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\n通过 ${passed} / ${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
