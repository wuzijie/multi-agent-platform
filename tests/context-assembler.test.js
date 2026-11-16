#!/usr/bin/env node
/**
 * 动态上下文管理测试：
 *   1) assembleIncrementalContext 六段结构与顺序
 *   2) Warm Path 逐条展开（@你 标记）
 *   3) Cold Path 确定性简报（长度上限、参与者归纳）
 *   4) Token 预算：从最旧丢弃
 *   5) 乒乓警告条件注入
 *   6) 触发原文头尾截断
 *   7) messageLog.unread 投递过滤（system/display/briefing/whisper/自身）
 *   8) delivery_cursor 推进后未读为空
 *
 * 运行：node tests/context-assembler.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { assembleIncrementalContext, trimOldest, truncateTrigger, deliveryConfig } = require('../src/prompt/context-assembler');
const messageLog = require('../src/messaging/message-log');
const cursorStore = require('../src/messaging/cursor-store');

const ROOT = path.resolve(__dirname, '..');
const TASK_ID = `test_ctx_${Date.now()}`;
const TASK_DIR = path.join(ROOT, 'tasks', TASK_ID);

function msg(seq, role, agent, content, extra = {}) {
  return Object.assign({ seq, ts: new Date().toISOString(), role, agent, kind: 'chat', content }, extra);
}

function baseInput(overrides = {}) {
  return Object.assign({
    targetAgent: '迪普斯克',
    fromAgent: '克劳德',
    triggerModel: 'Claude',
    triggerContent: '我认为方案可行。\n\n@迪普斯克\n请评审技术风险',
    mentionDesc: '请评审技术风险',
    unread: [
      msg(1, 'user', null, '请分析一下方案'),
      msg(2, 'assistant', '克劳德', '我认为方案可行。\n\n@迪普斯克\n请评审技术风险'),
    ],
    roster: [
      { name: '克劳德', model_cli: 'claude', strengths: ['逻辑严谨'], busy: false, online: true },
      { name: '迪普斯克', model_cli: 'deepseek', strengths: ['技术深度'], busy: true, online: true },
    ],
    activeTasks: [],
    recentFiles: ['M src/a.js'],
    turn: { summonSeq: 2, hop: 1, chain: ['用户', '克劳德'], pairCount: 1, warn: false, warnThreshold: 2, blockThreshold: 4 },
  }, overrides);
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

function cleanup() {
  try { fs.rmSync(TASK_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

console.log('\n【动态上下文组装】');

test('六段结构与顺序：来源/模式/导航/触发原文/未读历史/系统提示', () => {
  const r = assembleIncrementalContext(baseInput());
  const order = ['[来源标识]', '[模式声明]', '[导航头]', '[触发消息原文]', '[未读历史]', '[系统提示]'];
  let last = -1;
  for (const head of order) {
    const idx = r.prompt.indexOf(head);
    assert.ok(idx >= 0, `缺少段落 ${head}`);
    assert.ok(idx > last, `段落顺序错误：${head}`);
    last = idx;
  }
  assert.ok(r.prompt.includes('Direct message from 克劳德 [model=Claude]'), '来源标识内容');
  assert.ok(r.prompt.includes('你是本轮第 2 只被召唤的 agent CLI'), '模式声明序号');
  assert.ok(r.prompt.includes('接力棒：克劳德 → 你'), '导航头接力棒');
  assert.ok(r.prompt.includes('> 请评审技术风险'), '触发原文含任务描述');
  assert.ok(r.prompt.includes('传球决策树') || r.prompt.includes('先判断'), '系统提示-决策树');
  assert.ok(r.prompt.includes('接力棒在你手里'), '系统提示-球权检查');
});

test('Warm Path：逐条展开并标注 @你', () => {
  const r = assembleIncrementalContext(baseInput());
  assert.strictEqual(r.stats.path, 'warm');
  assert.ok(r.prompt.includes('[#1 用户]'), '用户消息标签');
  assert.ok(r.prompt.includes('[#2 克劳德（@你）]'), '转交消息标注 @你');
});

test('Cold Path：大量未读走简报且不超上限', () => {
  const unread = [];
  for (let i = 1; i <= 40; i++) {
    unread.push(msg(i, i % 2 === 0 ? 'assistant' : 'user', i % 2 === 0 ? '克劳德' : null,
      `第 ${i} 条消息：` + '长内容'.repeat(80)));
  }
  const r = assembleIncrementalContext(baseInput({ unread }));
  const d = deliveryConfig();
  assert.strictEqual(r.stats.path, 'cold');
  assert.ok(r.stats.unread_chars <= d.coldBriefMaxChars + 100, '简报长度应受 cold_brief_max_chars 约束');
  assert.ok(r.prompt.includes('【未读简报】'), '包含简报头');
  assert.ok(/克劳德：\d+ 条/.test(r.prompt), '参与者归纳');
});

test('预算裁剪：从最旧丢弃、保留最新', () => {
  const unread = [];
  for (let i = 1; i <= 10; i++) unread.push(msg(i, 'user', null, `消息${i}` + 'x'.repeat(100)));
  const { kept, dropped } = trimOldest(unread, 500);
  assert.ok(dropped > 0, '应有消息被丢弃');
  assert.ok(kept.length > 0, '应保留最新若干条');
  assert.strictEqual(kept[kept.length - 1].seq, 10, '最后一条（最新）必须保留');
  assert.ok(kept[0].seq > 1, '最旧的消息应被丢弃');
});

test('乒乓警告：warn=true 时注入，warn=false 时不注入', () => {
  const warnCase = assembleIncrementalContext(baseInput({
    turn: { summonSeq: 3, hop: 2, chain: ['用户', '克劳德'], pairCount: 2, warn: true, warnThreshold: 2, blockThreshold: 4 },
  }));
  assert.ok(warnCase.prompt.includes('[乒乓警告]'), '应注入乒乓警告');
  assert.ok(warnCase.prompt.includes('已来回 2 次'), '警告应含往返次数');
  assert.ok(warnCase.prompt.includes('4 次将强制阻断'), '警告应含阻断阈值');

  const noWarn = assembleIncrementalContext(baseInput());
  assert.ok(!noWarn.prompt.includes('[乒乓警告]'), '未达阈值不注入警告');
});

test('触发原文超长：头尾截断并标注省略', () => {
  const long = '头'.repeat(100) + '中'.repeat(2000) + '尾'.repeat(100);
  const t = truncateTrigger(long, 60, 40);
  assert.ok(t.startsWith('头'.repeat(60)), '保留头部');
  assert.ok(t.endsWith('尾'.repeat(40)), '保留尾部');
  assert.ok(t.includes('中间省略'), '标注省略');
});

console.log('\n【投递游标与消息过滤】');

test('messageLog.unread：过滤 system/display/briefing/whisper/自身输出', () => {
  fs.mkdirSync(TASK_DIR, { recursive: true });
  messageLog.append(TASK_ID, { role: 'user', content: '用户问题' });                                     // seq1 应投递
  messageLog.append(TASK_ID, { role: 'system', content: '系统展示', kind: 'display' });                  // seq2 过滤
  messageLog.append(TASK_ID, { role: 'assistant', agent: '克劳德', content: '克劳德回复' });              // seq3 应投递
  messageLog.append(TASK_ID, { role: 'assistant', agent: '迪普斯克', content: '自己的旧输出' });          // seq4 过滤（自身）
  messageLog.append(TASK_ID, { role: 'user', agent: '克劳德', content: '@迪普斯克\n请接着做' });           // seq5 应投递
  messageLog.append(TASK_ID, { role: 'user', agent: '钱文', kind: 'whisper', visible_to: ['钱文'], content: '私语' }); // seq6 对迪普斯克不可见
  messageLog.append(TASK_ID, { role: 'system', kind: 'briefing', content: '简报' });                     // seq7 过滤

  const unreadList = messageLog.unread(TASK_ID, { cursorSeq: 0, agent: '迪普斯克' });
  const seqs = unreadList.map(m => m.seq);
  assert.deepStrictEqual(seqs, [1, 3, 5], `实际投递 ${JSON.stringify(seqs)}`);
});

test('delivery_cursor：推进后对应消息不再投递', () => {
  cursorStore.advanceDeliveryCursor(TASK_ID, '迪普斯克', 3);
  assert.strictEqual(cursorStore.get(TASK_ID, '迪普斯克').delivery_cursor, 3);
  const unreadList = messageLog.unread(TASK_ID, { cursorSeq: 3, agent: '迪普斯克' });
  assert.deepStrictEqual(unreadList.map(m => m.seq), [5], '只应剩游标之后的消息');
});

test('messageLog.unread：whisper 对名单内 agent 可见', () => {
  messageLog.append(TASK_ID, { role: 'user', agent: '钱文', kind: 'whisper', visible_to: ['迪普斯克'], content: '给迪普斯克的私语' });
  const list = messageLog.unread(TASK_ID, { cursorSeq: 3, agent: '迪普斯克' });
  assert.ok(list.some(m => m.content === '给迪普斯克的私语'), 'whisper 名单内应可见');
});

cleanup();
console.log(`\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) process.exit(1);
