#!/usr/bin/env node
/**
 * 一轮对话路由测试：双 @ 并行、首行转交、模型多 @ 违规、无 @ 承接
 * 用假 _streamedExecute，不调用真实 CLI。
 * 运行：node tests/turn-routing.test.js
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
  console.log('\n【一轮对话路由】');

  await test('两个 @ → 并行调用两个 agent', async () => {
    const tid = await newTask('双@并行');
    const calls = stubAgent({ 克劳德: 'A 的回答', 钱文: 'B 的回答' });
    const task = orchestrator.getTask(tid);
    const r = await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 @钱文 同一个问题', '同一个问题', ['克劳德', '钱文']);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls.map(c => c.agent).sort(), ['克劳德', '钱文'].sort());
    assert.ok(r.result.content.includes('A 的回答'));
    assert.ok(r.result.content.includes('B 的回答'));
    const msgs = messageLog.loadAll(tid);
    assert.strictEqual(msgs.filter(m => m.role === 'assistant').length, 2);
  });

  await test('模型首行 @ → 拉起被 @ 的 agent', async () => {
    const tid = await newTask('首行转交');
    const calls = stubAgent((agent) => (agent === '克劳德' ? '@钱文 请补充中文说明' : '钱文补充完成'));
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 解释一下', '解释一下', ['克劳德']);
    assert.deepStrictEqual(calls.map(c => c.agent), ['克劳德', '钱文']);
    assert.ok(calls[1].instruction.includes('请补充中文说明'));
  });

  await test('模型首行 @ 两个 → 忽略转交并记录违规', async () => {
    const tid = await newTask('模型多@');
    const calls = stubAgent({ 克劳德: '@钱文 @吉米 你们一起看' });
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 看下', '看下', ['克劳德']);
    assert.strictEqual(calls.length, 1, '违规转交不应拉起任何 agent');
    const conv = orchestrator.getConversation(tid);
    assert.ok(conv.includes('违规转交'));
  });

  await test('非首行 @ 不触发转交', async () => {
    const tid = await newTask('非首行@');
    const calls = stubAgent({ 克劳德: '这是回答\n@钱文 后面这行不触发' });
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 回答', '回答', ['克劳德']);
    assert.strictEqual(calls.length, 1);
  });

  await test('正文「建议下一棒交给钱文」→ 不触发转交（严格首行）', async () => {
    const tid = await newTask('正文转交不触发');
    const calls = stubAgent((agent) => (agent === '克劳德'
      ? '方案已完成。建议下一棒交给钱文，按体系化文档汇总。'
      : '钱文已接手'));
    const task = orchestrator.getTask(tid);
    await orchestrator._executeTurnWithAgents(task, tid, '@克劳德 出个方案', '出个方案', ['克劳德']);
    assert.deepStrictEqual(calls.map(c => c.agent), ['克劳德'], '正文建议不应拉起其他 agent');
    assert.ok(!orchestrator.getConversation(tid).includes('[格式纠正]'));
  });

  await test('执行许可关键词识别', async () => {
    assert.strictEqual(orchestrator._detectOperatorApproval('可以开始执行了'), true);
    assert.strictEqual(orchestrator._detectOperatorApproval('按这个方案执行吧'), true);
    assert.strictEqual(orchestrator._detectOperatorApproval('授权，开始改'), true);
    assert.strictEqual(orchestrator._detectOperatorApproval('先分析一下'), false);
    assert.strictEqual(orchestrator._detectOperatorApproval('可以开始执行吗？'), false);
  });

  await test('无 @ 时取最近回复的 agent', async () => {
    const tid = await newTask('粘性承接');
    messageLog.append(tid, { role: 'assistant', agent: '克劳德', content: '旧回复' });
    messageLog.append(tid, { role: 'assistant', agent: '钱文', content: '更新的回复' });
    assert.strictEqual(messageLog.latestAssistantAgent(tid), '钱文');
  });

  for (const id of created) {
    try { fs.rmSync(path.join(ROOT, 'tasks', id), { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\n通过 ${passed} / ${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
