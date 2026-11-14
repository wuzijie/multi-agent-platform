/**
 * 取消本轮 vs 结束对话 的语义测试
 *
 * 规则：
 *   - Session.cancel()：只标记 cancelledTurn，不把会话/任务判为 completed
 *   - Session.markCompleted()：结束对话
 *   - _finishStoppedTurn：任务保持 executing，用户可继续输入
 *
 * 运行：node tests/cancel-turn.test.js
 */
const sessionManager = require('../src/session/manager');
const orchestrator = require('../src/orchestrator/orchestrator');

let failures = 0;
function assert(cond, name) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

console.log('[1] Session.cancel 只取消本轮');
const s = sessionManager.get('cancel_turn_test');
s.status = 'running';
s.cancel();
assert(s.isCancelled() === true, 'cancelledTurn = true');
assert(s.status !== 'completed', '会话状态不是 completed');

console.log('\n[2] beginTurn 复位取消标志');
s.beginTurn();
assert(s.isCancelled() === false, '新一轮取消标志复位');
assert(s.status === 'running', '新一轮状态回到 running');

console.log('\n[3] markCompleted 才结束对话');
s.cancel();
s.markCompleted();
assert(s.status === 'completed', 'markCompleted 后状态为 completed');

console.log('\n[4] _finishStoppedTurn 保持任务 executing');
const task = { task_id: 'cancel_turn_test', status: 'executing' };
const originals = {
  append: orchestrator._appendConversation,
  save: orchestrator._saveTask,
  index: orchestrator._updateIndex,
};
orchestrator._appendConversation = () => {};
orchestrator._saveTask = () => {};
orchestrator._updateIndex = () => {};
try {
  const res = orchestrator._finishStoppedTurn(task, 'cancel_turn_test');
  assert(task.status === 'executing', '任务状态保持 executing');
  assert(task.last_run_status === 'stopped', '记录 last_run_status = stopped');
  assert(res.stopped === true, '返回 stopped 标记');
} finally {
  orchestrator._appendConversation = originals.append;
  orchestrator._saveTask = originals.save;
  orchestrator._updateIndex = originals.index;
}

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
