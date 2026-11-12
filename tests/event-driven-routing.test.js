/**
 * 自动事件驱动路由测试
 *
 * 规则：
 *   - “多模型分工 / 多步骤拆解”类执行意图 → 自动进入事件驱动
 *   - 知识问答（解释/如何/为什么…）、单 Agent 请求、显式讨论关键词 → 不触发
 *
 * 运行：node tests/event-driven-routing.test.js
 */
const orchestrator = require('../src/orchestrator/orchestrator');

const isIntent = orchestrator.isEventDrivenIntent;
let failures = 0;

function expect(result, name) {
  if (result) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

function expectTrue(msg) { expect(isIntent(msg) === true, `触发：${msg}`); }
function expectFalse(msg) { expect(isIntent(msg) === false, `不触发：${msg}`); }

console.log('[1] 应自动进入事件驱动的表达');
expectTrue('让多个模型分工完成这个任务');
expectTrue('多模型分别分析这段代码，然后汇总');
expectTrue('把这个需求拆解成几个子任务');
expectTrue('先调研，再写方案，最后评审汇总');
expectTrue('团队协作完成这个需求');
expectTrue('多模型一起评审一下这个方案');
expectTrue('把任务分成三步来做');
expectTrue('请安排多个智能体并行处理这几个模块');

console.log('\n[2] 不应触发的表达');
expectFalse('解释一下多 Agent 协同机制');
expectFalse('如何设计一个多智能体系统');
expectFalse('如何让多个模型协作完成任务');
expectFalse('帮我调研一下');
expectFalse('写一个快排');
expectFalse('多模型架构设计');
expectFalse('多智能体如何防止任务丢失');
expectFalse('为什么多个模型讨论同一个问题会更好');
expectFalse('什么是事件驱动');
expectFalse('先解释一下原理，再说说实现');
expectFalse('把上面的结论再说一遍');
expectFalse('介绍几个多模型框架');
expectFalse('你好');
expectFalse('');
expectFalse(null);

console.log('\n[3] 显式模式优先（由 executeSimpleTask 判定，这里验证意图函数边界）');
expectFalse('多模型讨论一下这个架构'); // 讨论/辩论关键词由 detectCollabMode 接管
expectFalse('一对一辩论：要不要引入 Redis');

console.log('\n[4] 与三种协作模式关键词冲突：关键词任意位置都让位');
const shouldAuto = orchestrator.shouldAutoEventDriven;
const hasModeKeyword = orchestrator.hasExplicitCollabModeKeyword;

function expectEq(actual, expected, name) {
  if (actual === expected) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}（期望 ${expected}，实际 ${actual}）`);
  }
}

expectEq(hasModeKeyword('多模型讨论'), true, '识别 debate 关键词');
expectEq(hasModeKeyword('帮我用头脑风暴拆解一下'), true, '识别句中 brainstorm 关键词');
expectEq(hasModeKeyword('一对一辩论：要不要引入 Redis'), true, '识别 duel 关键词');
expectEq(hasModeKeyword('多模型分别分析这段代码'), false, '“多模型”本身不算模式关键词');

expectEq(shouldAuto('用多模型讨论的方式拆解这个任务', {}), false, '句中 debate 关键词 → 不自动进 DAG');
expectEq(shouldAuto('帮我用头脑风暴拆解一下需求', {}), false, '句中 brainstorm 关键词 → 不自动进 DAG');
expectEq(shouldAuto('先头脑风暴，再拆解成子任务', {}), false, '句中 brainstorm 关键词 → 不自动进 DAG（含拆解）');
expectEq(shouldAuto('帮我组织一场一对一辩论，然后把结论汇总成方案', {}), false, '句中 duel 关键词 → 不自动进 DAG');
expectEq(shouldAuto('多方辩论一下，再拆解成子任务', {}), false, '开头 debate 关键词 → 不自动进 DAG');
expectEq(shouldAuto('多模型讨论一下这个架构', {}), false, '开头 debate 关键词 → 不自动进 DAG');

console.log('\n[5] 显式参数优先');
expectEq(shouldAuto('让多个模型分工完成', { collab_mode: 'debate' }), false, '显式 collab_mode → 不自动进 DAG');
expectEq(shouldAuto('让多个模型分工完成', { mentioned_agent: '克劳德' }), false, '@单个模型 → 不自动进 DAG');
expectEq(shouldAuto('让多个模型分工完成', { discussion_agents: ['克劳德', '钱文'] }), false, '@2+模型讨论 → 不自动进 DAG');
expectEq(shouldAuto('让多个模型分工完成', { discussion_agents: ['克劳德'] }), true, '仅 1 个讨论者 → 仍可自动进 DAG');

console.log('\n[6] 无冲突的正常自动触发');
expectEq(shouldAuto('多模型分别分析这段代码，然后汇总', {}), true, '多模型 + 动作 + 分别 → 自动进 DAG');
expectEq(shouldAuto('把任务拆解成三个子任务', {}), true, '拆解意图 → 自动进 DAG');

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
