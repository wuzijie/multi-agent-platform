#!/usr/bin/env node
/**
 * Prompt 模板渲染测试：统一渲染器 + 变量注入 + 可 @ 名单
 * 运行：node tests/prompt-template.test.js
 */
const assert = require('assert');
const path = require('path');
const { buildPrompt } = require('../src/adapters/prompt-template');
const renderer = require('../src/prompt/renderer');
const config = require('../src/utils/config');
config.loadAll();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n【Prompt 模板渲染】');

test('buildPrompt 包含身份、能力、上下文与指令', () => {
  const p = buildPrompt({ agentName: '克劳德', role: 'executor', taskId: 't1', context: 'CTX', instruction: 'INS' });
  assert.ok(p.includes('执行者智能体（克劳德）'));
  assert.ok(p.includes('## 我的能力'));
  assert.ok(p.includes('名称：克劳德'));
  assert.ok(p.includes('CTX'));
  assert.ok(p.includes('INS'));
});

test('buildPrompt 向后兼容 agentLabel', () => {
  const p = buildPrompt({ agentLabel: '钱文', role: 'executor', taskId: 't2', context: '', instruction: '' });
  assert.ok(p.includes('钱文'));
});

test('稳定上下文注入 @ 规则与可 @ 名单', () => {
  const agents = config.agents.filter(a => a.enabled !== false);
  const s = renderer.buildStableContext({ mentionMax: 2, availableAgents: agents, sessionGoal: '目标', memory: '记忆' });
  assert.ok(s.includes('团队协作与 @ 规则'));
  assert.ok(s.includes('一次最多 @ 2 个'));
  assert.ok(s.includes('克劳德'));
  assert.ok(s.includes('## 会话目标\n目标'));
  assert.ok(s.includes('记忆'));
});

test('render 替换 {{变量}}', () => {
  const out = renderer.render('session_goal', { session_goal: 'X' });
  assert.strictEqual(out.trim(), '## 会话目标\nX'.trim());
});

test('不同 agent 注入不同模型/能力档案', () => {
  const c = buildPrompt({ agentName: '克劳德', role: 'executor', taskId: 't', context: '', instruction: '' });
  const d = buildPrompt({ agentName: '迪普斯克', role: 'executor', taskId: 't', context: '', instruction: '' });
  assert.ok(c.includes('Claude'));
  assert.ok(d.includes('DeepSeek'));
  assert.ok(!c.includes('DeepSeek'));
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
