#!/usr/bin/env node
/**
 * 首行 @ 解析规则测试
 * 运行：node tests/mention.test.js
 */
const assert = require('assert');
const path = require('path');
const { parseLeadingMentions } = require(path.resolve(__dirname, '..', 'src/messaging/mention'));

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

console.log('\n【首行 @ 解析】');

test('无 @ → 不指定 agent', () => {
  const r = parseLeadingMentions('帮我写个函数', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, []);
  assert.strictEqual(r.rest, '帮我写个函数');
});

test('单个 @ → 命中并剥离', () => {
  const r = parseLeadingMentions('@克劳德 帮我写个函数', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, ['克劳德']);
  assert.strictEqual(r.rest, '帮我写个函数');
});

test('两个 @ → 全部命中（并行）', () => {
  const r = parseLeadingMentions('@克劳德 @钱文 一起回答这个问题', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, ['克劳德', '钱文']);
  assert.strictEqual(r.rest, '一起回答这个问题');
});

test('超过上限 → error', () => {
  const r = parseLeadingMentions('@克劳德 @钱文 @吉米 回答', { max: 2, agents, aliases });
  assert.ok(r.error);
  assert.strictEqual(r.error.code, 'TOO_MANY_MENTIONS');
  assert.deepStrictEqual(r.agents, []);
});

test('模型上限为 1 时，两个 @ → error', () => {
  const r = parseLeadingMentions('@克劳德 @钱文 回答', { max: 1, agents, aliases });
  assert.ok(r.error);
  assert.strictEqual(r.error.code, 'TOO_MANY_MENTIONS');
});

test('未知 agent → error 且列出可用名单', () => {
  const r = parseLeadingMentions('@不存在 你好', { max: 2, agents, aliases });
  assert.ok(r.error);
  assert.strictEqual(r.error.code, 'UNKNOWN_AGENT');
  assert.ok(r.error.message.includes('克劳德'));
});

test('非首行 @ 完全忽略', () => {
  const r = parseLeadingMentions('你好\n@钱文 帮我看下', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, []);
});

test('别名 @claude 命中克劳德', () => {
  const r = parseLeadingMentions('@claude hello', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, ['克劳德']);
  assert.strictEqual(r.rest, 'hello');
});

test('重复 @ 同一 agent 去重', () => {
  const r = parseLeadingMentions('@克劳德 @克劳德 做点事', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, ['克劳德']);
  assert.strictEqual(r.rest, '做点事');
});

test('只有 @ 没有内容 → rest 为空', () => {
  const r = parseLeadingMentions('@克劳德', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, ['克劳德']);
  assert.strictEqual(r.rest, '');
});

test('行首空白容忍', () => {
  const r = parseLeadingMentions('   @钱文 你好', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, ['钱文']);
});

test('正文中的 @ 不影响', () => {
  const r = parseLeadingMentions('请解释 @克劳德 是什么', { max: 2, agents, aliases });
  assert.deepStrictEqual(r.agents, []);
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
