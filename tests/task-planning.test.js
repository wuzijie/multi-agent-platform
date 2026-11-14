/**
 * DAG 规划依赖校验测试
 *
 * 规则：
 *   - deps 只能指向序号更小的子任务（更早节点）
 *   - 越界 / 自依赖 / 前向依赖 / 非整数 / 负数 / 非对象节点 → 整份规划视为非法（返回 null，回退默认 DAG）
 *   - 环在结构上不可能出现（边只指向更早节点）
 *   - 数字字符串兼容、重复依赖去重
 *
 * 运行：node tests/task-planning.test.js
 */
const orchestrator = require('../src/orchestrator/orchestrator');

const TRACE = 'task_test_20261017';
let failures = 0;

function assert(cond, name, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
    if (detail) console.error(detail);
  }
}

function plan(items) {
  return orchestrator._parsePlanOutput(JSON.stringify(items), '用户请求', TRACE);
}

const silent = (fn) => {
  const original = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = original; }
};

console.log('[1] 合法规划');
const valid = plan([
  { type: 'PLAN_TASK', instruction: '规划', deps: [], agent: '克劳德' },
  { type: 'CODE_TASK', instruction: '执行', deps: [0], agent: '迪普斯克' },
  { type: 'SUMMARY_TASK', instruction: '汇总', deps: [0, 1], agent: '克劳德' },
]);
assert(valid && valid.length === 3, '三个节点均被解析');
assert(valid && valid[1].deps[0] === `${TRACE}__sub_000`, '直接依赖解析正确');
assert(valid && valid[2].deps.length === 2, '显式声明祖先依赖（0,1）被保留');
assert(valid && valid[2].role === 'guardian', 'SUMMARY_TASK 映射为 guardian');

const stringDeps = plan([{}, { deps: ['0'] }]);
assert(stringDeps && stringDeps[1].deps[0] === `${TRACE}__sub_000`, '数字字符串依赖兼容');

const dupDeps = plan([{}, { deps: [0, 0, '0'] }]);
assert(dupDeps && dupDeps[1].deps.length === 1, '重复依赖去重');

console.log('\n[2] 非法规划整体作废（返回 null）');
silent(() => {
  assert(plan([{ deps: [1] }, {}]) === null, '前向依赖 → 作废');
  assert(plan([{}, { deps: [1] }]) === null, '自依赖 → 作废');
  assert(plan([{}, { deps: [5] }]) === null, '越界依赖 → 作废');
  assert(plan([{}, { deps: ['x'] }]) === null, '非整数依赖 → 作废');
  assert(plan([{}, { deps: [-1] }]) === null, '负数依赖 → 作废');
  assert(plan(['不是节点']) === null, '节点非对象 → 作废');
  assert(plan([{ deps: [1] }, { deps: [0] }]) === null, '成环规划 → 作废');
});

console.log('\n[3] 多根与跨层依赖');
const diamond = plan([
  { type: 'PLAN_TASK', instruction: '调研A', deps: [] },
  { type: 'PLAN_TASK', instruction: '调研B', deps: [] },
  { type: 'CODE_TASK', instruction: '初稿', deps: [0, 1] },
  { type: 'SUMMARY_TASK', instruction: '汇总', deps: [0, 2] },
]);
assert(diamond && diamond[3].deps.includes(`${TRACE}__sub_000`), '汇总节点可显式取根节点原始产出');
assert(diamond && diamond[3].deps.includes(`${TRACE}__sub_002`), '汇总节点同时依赖初稿');
assert(diamond && diamond[0].deps.length === 0 && diamond[1].deps.length === 0, '多根节点无依赖');

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
