#!/usr/bin/env node
/**
 * 固定协作模式注销测试
 * 运行：node tests/collab-modes-disabled.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const config = require(path.join(ROOT, 'src/utils/config'));
config.loadAll();
// 关闭自动 DAG 路由，保证本测试能断言“回落到普通对话”
config.routing = Object.assign({}, config.routing, { auto_event_driven: false });

const registry = require(path.join(ROOT, 'src/orchestrator/collab-mode-registry'));
const orchestrator = require(path.join(ROOT, 'src/orchestrator/orchestrator'));
const toolRegistry = require(path.join(ROOT, 'src/tools/registry'));

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

(async () => {
  console.log('\n【固定协作模式注销】');

  await test('注册表：四种固定模式均为注销状态', () => {
    for (const m of ['debate', 'brainstorm', 'duel', 'discussion']) {
      assert.strictEqual(registry.isEnabled(m), false, `${m} 应为注销`);
    }
  });

  await test('FC 工具未注册 debate/brainstorm/duel', () => {
    toolRegistry.init();
    const tools = toolRegistry.list ? toolRegistry.list().map(t => t.name) : [];
    const names = tools.length ? tools : Array.from(toolRegistry._tools.keys());
    for (const m of ['debate', 'brainstorm', 'duel']) {
      assert.ok(!names.includes(m), `${m} 不应注册为工具`);
    }
    assert.ok(names.includes('deep_research'), '其他工具不受影响');
  });

  await test('显式 collab_mode=duel 被注销 → 按普通对话处理', async () => {
    const tid = await newTask('注销后显式请求');
    let fellThrough = false;
    orchestrator._executeTurnWithAgents = async () => { fellThrough = true; return { task: orchestrator.getTask(tid), result: { status: 'success', content: 'ok' } }; };
    const task = orchestrator.getTask(tid);
    await orchestrator.executeSimpleTask(tid, '帮我分析一下', { collab_mode: 'duel' });
    assert.strictEqual(fellThrough, true, '应回落到普通对话');
    assert.ok(orchestrator.getConversation(tid).includes('[已停用]'));
  });

  await test('关键词“头脑风暴一下”不再进入头脑风暴模式', async () => {
    const tid = await newTask('注销后关键词');
    let entered = false;
    orchestrator._executeBrainstormMode = async () => { entered = true; throw new Error('should not enter'); };
    let fellThrough = false;
    orchestrator._executeTurnWithAgents = async () => { fellThrough = true; return { task: orchestrator.getTask(tid), result: { status: 'success', content: 'ok' } }; };
    await orchestrator.executeSimpleTask(tid, '头脑风暴一下：如何提高效率');
    assert.strictEqual(entered, false, '不应进入头脑风暴模式');
    assert.strictEqual(fellThrough, true, '应按普通对话处理');
  });

  await test('代码实现仍保留（注销≠删除）', () => {
    const p = path.join(ROOT, 'src/orchestrator/collab-modes.js');
    assert.ok(fs.existsSync(p));
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(src.includes('_executeDuelMode'));
    assert.ok(src.includes('_executeBrainstormMode'));
    assert.ok(src.includes('_executeDebateMode'));
  });

  for (const id of created) {
    try { fs.rmSync(path.join(ROOT, 'tasks', id), { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\n通过 ${passed} / ${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
