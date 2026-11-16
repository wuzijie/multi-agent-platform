#!/usr/bin/env node
/**
 * 会话日志存储测试：按天文件夹 + 按会话文件
 * 运行：node tests/log-store.test.js
 *
 * 覆盖：
 *   1) 文件命名：<session_id>.log / _system.log（非法字符替换）
 *   2) LogStore.append 写入 logs/YYYY-MM-DD/ 下对应会话文件
 *   3) 读取：readSessionEntries / scanEntries / readRecent
 *   4) ModelLogger 按会话归档 + getLogsByTaskId/getRequestPairs 查询
 *   5) CollabLogger 会话推断 + EventBus 事件落会话文件
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LogStore = require('../src/utils/log-store');
const ModelLogger = require('../src/utils/model-logger');
const CollabLogger = require('../src/utils/collab-logger');
const eventBus = require('../src/eventbus/bus');

const ROOT = path.resolve(__dirname, '..');
const DAY = LogStore.dayKey();
const SID = `logstore_test_${Date.now()}`;
const NO_SID_MARK = `nosid_${Date.now()}`;

function sessionFile(sid) {
  // 找到实际写入的根（多根时取第一个存在的文件）
  for (const root of LogStore.LOG_ROOTS) {
    const f = path.join(root, 'logs', DAY, LogStore.sessionFileName(sid));
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function cleanup() {
  for (const f of [sessionFile(SID), sessionFile(NO_SID_MARK)]) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* 忽略 */ }
  }
  // _system.log 只删除本测试写入的行，避免污染真实日志
  for (const root of LogStore.LOG_ROOTS) {
    const f = path.join(root, 'logs', DAY, '_system.log');
    try {
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim() && !l.includes(NO_SID_MARK));
      if (lines.length === 0) fs.unlinkSync(f);
      else fs.writeFileSync(f, lines.join('\n') + '\n');
    } catch (e) { /* 忽略 */ }
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

async function main() {
  console.log('\n【会话日志存储】');

  await test('sessionFileName：会话 ID → 文件名，空值落 _system', () => {
    assert.strictEqual(LogStore.sessionFileName('abc-123_x.y'), 'abc-123_x.y.log');
    assert.strictEqual(LogStore.sessionFileName('a/b c'), 'a_b_c.log');
    assert.strictEqual(LogStore.sessionFileName(''), '_system.log');
    assert.strictEqual(LogStore.sessionFileName(null), '_system.log');
  });

  await test('dayKey：YYYY-MM-DD 日期文件夹名', () => {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(LogStore.dayKey(new Date(2026, 10, 14))));
    assert.strictEqual(LogStore.dayKey(new Date(2026, 10, 14)), '2026-11-14');
  });

  await test('append：日志写到 logs/<日期>/<会话>.log（JSONL）', () => {
    const ok = LogStore.append(SID, { log_type: 'model', agent_name: '测试', content: 'hello' });
    assert.ok(ok, 'append 应返回 true');
    const f = sessionFile(SID);
    assert.ok(f, '会话文件应存在');
    assert.ok(f.includes(path.join('logs', DAY, `${SID}.log`)), '应位于日期文件夹下');
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.session_id, SID);
    assert.strictEqual(entry.log_type, 'model');
    assert.ok(entry.timestamp);
  });

  await test('append：无会话归属写 _system.log', () => {
    const ok = LogStore.append('', { log_type: 'analytics', type: 'test_marker', marker: NO_SID_MARK });
    assert.ok(ok);
    let found = false;
    for (const root of LogStore.LOG_ROOTS) {
      const f = path.join(root, 'logs', DAY, '_system.log');
      if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(NO_SID_MARK)) found = true;
    }
    assert.ok(found, '_system.log 应包含该条目');
  });

  await test('readSessionEntries：跨日期文件夹按会话读取', () => {
    const entries = LogStore.readSessionEntries(SID);
    assert.ok(entries.length >= 1);
    assert.ok(entries.every(e => e.session_id === SID));
  });

  await test('scanEntries / readRecent：过滤与倒序', () => {
    LogStore.append(SID, { log_type: 'collab', event: 'probe', marker: 'scan_me' });
    const found = LogStore.scanEntries(e => e.marker === 'scan_me');
    assert.strictEqual(found.length, 1);

    const recent = LogStore.readRecent(e => e.session_id === SID, 10);
    assert.ok(recent.length >= 2);
    for (let i = 1; i < recent.length; i++) {
      assert.ok(String(recent[i - 1].timestamp) >= String(recent[i].timestamp), '应按时间倒序');
    }
  });

  await test('ModelLogger：按会话归档 + 任务查询 + 请求配对', () => {
    const meta = { task_id: 'sub_1', external_task_id: SID, agent_name: '测试', phase: 'initial', attempt: 1 };
    const reqId = ModelLogger.logRequest('TestAdapter', 'model-x', 'PROMPT_CONTENT', meta);
    ModelLogger.logResponse('TestAdapter', 'model-x', 'RESPONSE_CONTENT', { ...meta, request_id: reqId, status: 'success' });

    const f = sessionFile(SID);
    assert.ok(f, '模型日志应写入会话文件');
    const byExternal = ModelLogger.getLogsByExternalTaskId(SID);
    assert.ok(byExternal.some(e => e.direction === 'request' && e.request_id === reqId));
    assert.ok(byExternal.some(e => e.direction === 'response' && e.request_id === reqId));

    const byTask = ModelLogger.getLogsByTaskId(SID);
    assert.ok(byTask.length >= 2);

    const pairs = ModelLogger.pairEntries(byExternal);
    assert.ok(pairs.some(p => p.request && p.response && p.request.request_id === reqId));
  });

  await test('CollabLogger：从 data 推断会话并写入同一文件', () => {
    CollabLogger.log('task_cancel_effects', { task_id: SID, trace_id: 'tr_x', killed_procs: 0 });
    const entries = LogStore.readSessionEntries(SID).filter(e => e.log_type === 'collab');
    assert.ok(entries.some(e => e.event === 'task_cancel_effects'));
  });

  await test('EventBus：事件异步落盘到会话文件', async () => {
    eventBus.emit('task:created', { task_id: SID, name: 'event-test' });
    await new Promise(r => setTimeout(r, 100)); // 等 setImmediate 落盘
    const entries = LogStore.readSessionEntries(SID).filter(e => e.log_type === 'event');
    assert.ok(entries.some(e => e.event_type === 'task:created' && e.data && e.data.name === 'event-test'));
    const recent = eventBus.getRecentEvents(20);
    assert.ok(Array.isArray(recent));
  });

  await test('deleteSessionLogs：删除对话时连带清理会话日志文件', () => {
    const f = sessionFile(SID);
    assert.ok(f, '删除前会话文件应存在');
    const removed = LogStore.deleteSessionLogs(SID);
    assert.ok(removed >= 1, '应至少删除一个会话文件');
    assert.strictEqual(sessionFile(SID), null, '删除后会话文件应不存在');
    assert.strictEqual(LogStore.readSessionEntries(SID).length, 0);
  });

  cleanup();

  console.log(`\n通过 ${passed} / ${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); cleanup(); process.exit(1); });
