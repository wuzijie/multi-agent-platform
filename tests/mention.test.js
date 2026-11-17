#!/usr/bin/env node
/**
 * 行首 @ 解析规则测试（多行）
 * 运行：node tests/mention.test.js
 */
const assert = require('assert');
const path = require('path');
const { parseMentions } = require(path.resolve(__dirname, '..', 'src/messaging/mention'));

const agents = [
  { name: '克劳德', model_cli: 'claude' },
  { name: '吉米', model_cli: 'kimi' },
  { name: '迪普斯克', model_cli: 'deepseek' },
  { name: '钱文', model_cli: 'qwen' },
];
const aliases = { 克劳德: ['claude'], 吉米: ['kimi'], 迪普斯克: ['deepseek'], 钱文: ['qwen'] };

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n【行首 @ 解析（多行）】');

test('无 @ → 不指定 agent，body 为原文', () => {
  const r = parseMentions('帮我写个函数', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions, []);
  assert.strictEqual(r.body, '帮我写个函数');
  assert.strictEqual(r.error, null);
});

test('单行内联 @ → 命中并剥离描述', () => {
  const r = parseMentions('@克劳德 帮我写个函数', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['克劳德']);
  assert.strictEqual(r.mentions[0].description, '帮我写个函数');
});

test('同一行两个内联 @ → 共享同一描述（向后兼容）', () => {
  const r = parseMentions('@克劳德 @钱文 一起回答这个问题', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['克劳德', '钱文']);
  assert.strictEqual(r.mentions[0].description, '一起回答这个问题');
  assert.strictEqual(r.mentions[1].description, '一起回答这个问题');
});

test('超过上限 → TOO_MANY_MENTIONS', () => {
  const r = parseMentions('@克劳德 @钱文 @吉米 回答', { max: 2, agents, aliases });
  assert.ok(r.error);
  assert.strictEqual(r.error.code, 'TOO_MANY_MENTIONS');
});

test('未知 agent → UNKNOWN_AGENT 且列出可用名单', () => {
  const r = parseMentions('@不存在\n你好', { max: 2, agents, aliases });
  assert.ok(r.error);
  assert.strictEqual(r.error.code, 'UNKNOWN_AGENT');
  assert.ok(r.error.message.includes('克劳德'));
});

test('块描述：@ 独占一行，描述取下一行（多行）', () => {
  const r = parseMentions('@钱文\n帮我写单元测试\n覆盖所有边界情况', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['钱文']);
  assert.strictEqual(r.mentions[0].description, '帮我写单元测试\n覆盖所有边界情况');
});

test('多行两个 @ 各带独立任务（前端放置）', () => {
  const r = parseMentions('@克劳德\n写排序函数\n@钱文\n写单元测试', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['克劳德', '钱文']);
  assert.strictEqual(r.mentions[0].description, '写排序函数');
  assert.strictEqual(r.mentions[1].description, '写单元测试');
  assert.strictEqual(r.body, '');
});

test('末端放置：正文在前，@ 在后', () => {
  const r = parseMentions('帮我看看这个项目\n\n@克劳德\n写排序函数', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['克劳德']);
  assert.strictEqual(r.body, '帮我看看这个项目');
});

test('中间放置（前后都有正文）→ MIDDLE_PLACEMENT', () => {
  const r = parseMentions('帮我看看项目\n\n@克劳德\n写代码\n\n然后再总结', { max: 2, agents, aliases });
  assert.ok(r.error);
  assert.strictEqual(r.error.code, 'MIDDLE_PLACEMENT');
});

test('只有 @ 没有描述 → MISSING_DESCRIPTION', () => {
  const r = parseMentions('@克劳德', { max: 2, agents, aliases });
  assert.ok(r.error);
  assert.strictEqual(r.error.code, 'MISSING_DESCRIPTION');
});

test('代码块里的 @ 不识别', () => {
  const r = parseMentions('看这段代码\n```\n@克劳德 这是代码\n```', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions, []);
});

test('缩进代码（4+ 空格）里的 @ 不识别', () => {
  const r = parseMentions('    @钱文 缩进代码', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions, []);
});

test('自 @ 排除（currentAgent 自己）', () => {
  const r = parseMentions('@克劳德\n再检查一遍\n@钱文\n写测试', { max: 2, agents, aliases, currentAgent: '克劳德' });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['钱文']);
});

test('别名 @claude 命中克劳德', () => {
  const r = parseMentions('@claude hello', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['克劳德']);
  assert.strictEqual(r.mentions[0].description, 'hello');
});

test('重复 @ 同一 agent 去重', () => {
  const r = parseMentions('@克劳德\n任务A\n@克劳德\n任务B', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['克劳德']);
  assert.strictEqual(r.mentions[0].description, '任务A');
});

test('行首空白容忍（≤3 空格）', () => {
  const r = parseMentions('   @钱文\n你好', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions.map(m => m.agent), ['钱文']);
});

test('正文中的 @ 不影响', () => {
  const r = parseMentions('请解释 @克劳德 是什么', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions, []);
});

test('表格/引用/列表行内的 @ 不识别（非行首）', () => {
  const r = parseMentions('> @克劳德 引用里\n- @钱文 列表里\n| @克劳德 | 表格里 |', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.mentions, []);
});

console.log('\n【交接三选一：@用户 / [持球]】');

test('@用户 → terminal（交还用户），不产生 agent 提及', () => {
  const r = parseMentions('@用户\n需要你确认是否 force push', { max: 2, agents, aliases, currentAgent: '克劳德' });
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.mentions, []);
  assert.ok(r.terminal);
  assert.strictEqual(r.terminal.description, '需要你确认是否 force push');
  assert.strictEqual(r.hold, null);
});

test('@用户 与 @agent 混用 → MIXED_HANDOFF', () => {
  const r = parseMentions('@克劳德\n做A\n\n@用户\n确认B', { max: 2, agents, aliases });
  assert.strictEqual(r.error && r.error.code, 'MIXED_HANDOFF');
});

test('[持球:原因] → hold，正文保留', () => {
  const r = parseMentions('分析完成，等 CI 结果。\n\n[持球:等待 CI]', { max: 2, agents, aliases });
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.mentions, []);
  assert.ok(r.hold);
  assert.strictEqual(r.hold.reason, '等待 CI');
  assert.strictEqual(r.body, '分析完成，等 CI 结果。');
});

test('[持球] 无原因也可用', () => {
  const r = parseMentions('[持球]', { max: 2, agents, aliases });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.hold.reason, '');
});

test('[持球] 与 @ 混用 → HOLD_CONFLICT', () => {
  const r = parseMentions('@克劳德\n做A\n\n[持球:等 CI]', { max: 2, agents, aliases });
  assert.strictEqual(r.error && r.error.code, 'HOLD_CONFLICT');
});

test('[持球] 夹在正文中间 → MIDDLE_PLACEMENT', () => {
  const r = parseMentions('开头文字\n[持球:等 CI]\n结尾文字', { max: 2, agents, aliases });
  assert.strictEqual(r.error && r.error.code, 'MIDDLE_PLACEMENT');
});

test('@用户 缺说明 → MISSING_DESCRIPTION', () => {
  const r = parseMentions('@用户', { max: 2, agents, aliases });
  assert.strictEqual(r.error && r.error.code, 'MISSING_DESCRIPTION');
});

test('代码块里的 [持球] 不识别', () => {
  const r = parseMentions('看代码\n```\n[持球:等 CI]\n```', { max: 2, agents, aliases });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.hold, null);
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
