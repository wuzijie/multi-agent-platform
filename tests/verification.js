#!/usr/bin/env node

/**
 * 集成测试脚本
 *
 * 验证第一期所有核心模块是否正确实现
 * 不依赖外部 Agent CLI，仅测试框架层面的正确性
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');  // multi-agent-platform 根目录

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

console.log('\n========== 第一期功能验证 ==========\n');

// 1. 配置加载
console.log('【1. 配置加载器】');
const config = require('../src/utils/config');
config.loadAll();

test('加载 agents.yaml', () => {
  assert(Array.isArray(config.agents), 'agents should be an array');
  assert(config.agents.length >= 1, 'at least 1 agent configured');
});

test('加载 git.yaml', () => {
  assert(config.git && config.git.default_repo_url, 'git config should have default_repo_url');
  assert(config.git.auto_cleanup_days === 7, 'auto_cleanup_days should be 7');
});

test('加载 users.yaml', () => {
  assert(Array.isArray(config.users), 'users should be an array');
  assert(config.users[0] && config.users[0].role === 'admin', 'first user should be admin');
});

test('加载 task_defaults.yaml', () => {
  assert(config.taskDefaults.timeout_seconds === 600, 'timeout should be 600');
  assert(config.taskDefaults.max_revision_rounds === 3, 'max_revision_rounds should be 3');
});

test('getDefaultAgent() 返回默认Agent', () => {
  const agent = config.getDefaultAgent();
  assert(agent && agent.default === true, 'should return default agent');
});

test('getUserById() / isAdmin()', () => {
  assert(config.isAdmin('user_default'), 'user_default should be admin');
  assert(!config.isAdmin('nobody'), 'unknown user should not be admin');
});

// 2. CLI 抽象层
console.log('\n【2. CLI 抽象层】');
const { ClaudeAdapter, validateUnifiedInput, buildUnifiedOutput } = require('../src/adapters/claude');

test('validateUnifiedInput 验证必填字段', () => {
  const valid = { task_id: 'test-1', role: 'executor', context: 'test', instruction: 'do it' };
  assert(validateUnifiedInput(valid) === valid, 'valid input should pass');

  let threw = false;
  try { validateUnifiedInput({}); }
  catch (e) { threw = true; }
  assert(threw, 'empty input should throw');
});

test('validateUnifiedInput 验证 role 值', () => {
  let threw = false;
  try { validateUnifiedInput({ task_id: 't', role: 'invalid', context: 'c', instruction: 'i' }); }
  catch (e) { threw = true; }
  assert(threw, 'invalid role should throw');
});

test('buildUnifiedOutput 构建标准输出', () => {
  const output = buildUnifiedOutput('task-1', 'success', 'hello');
  assert(output.task_id === 'task-1', 'task_id should match');
  assert(output.status === 'success', 'status should be success');
  assert(output.content === 'hello', 'content should match');
  assert(output.duration_ms === 0, 'duration should default to 0');
});

test('ClaudeAdapter.getName()', () => {
  const adapter = new ClaudeAdapter();
  assert(adapter.getName() === 'ClaudeAdapter', 'getName should return adapter name');
});

// 3. File Event Bus
console.log('\n【3. File Event Bus】');
const eventBus = require('../src/eventbus/bus');

test('emit 发送事件', () => {
  const result = eventBus.emit('test:event', { key: 'value' });
  assert(result === true, 'emit should return true');
});

test('getRecentEvents 返回最近事件', () => {
  eventBus.emit('test:event2', { x: 1 });
  const events = eventBus.getRecentEvents(10);
  assert(events.length > 0, 'should have at least 1 event');
  assert(events[0].event_type, 'event should have event_type');
  assert(events[0].timestamp, 'event should have timestamp');
  assert(events[0].data, 'event should have data');
});

test('getEventsByType 按类型筛选', () => {
  eventBus.emit('custom:type', {});
  const events = eventBus.getEventsByType('custom:type', 10);
  assert(events.length > 0, 'should find events of custom:type');
  assert(events.every(e => e.event_type === 'custom:type'), 'all events should match type');
});

test('内存事件订阅', (done) => {
  eventBus.once('verify:subscription', (event) => {
    assert(event.event_type === 'verify:subscription', 'event type should match');
    assert(event.data.val === 42, 'event data should match');
    done();
  });
  eventBus.emit('verify:subscription', { val: 42 });
});

// 4. 特性清单系统
console.log('\n【4. 特性清单系统】');
const featureManager = require('../src/features/manager');

test('listFeatures 返回特性列表', () => {
  const features = featureManager.listFeatures();
  assert(Array.isArray(features), 'should return array');
  assert(features.length > 0, 'should have at least 1 feature');
});

test('createFeature 创建新特性', () => {
  const feature = featureManager.createFeature('测试特性', '这是一个测试', 'task_test');
  assert(feature.featureId, 'should have featureId');
  assert(feature.name === '测试特性', 'name should match');
});

test('updateFeature 更新特性状态', () => {
  const features = featureManager.listFeatures();
  const last = features[features.length - 1];
  const updated = featureManager.updateFeature(last.featureId, { status: '开发中', progress: '正在开发' });
  assert(updated.status === '开发中', 'status should be updated');
  assert(updated.progress === '正在开发', 'progress should be updated');
});

test('getStats 统计特性状态', () => {
  const stats = featureManager.getStats();
  assert(typeof stats.total === 'number', 'should have total count');
  assert(stats.by_status, 'should have by_status breakdown');
});

// 5. 任务编排器
console.log('\n【5. 任务编排器】');
const orchestrator = require('../src/orchestrator/orchestrator');

let testTaskId = null;

test('createTask 创建任务', async () => {
  const task = await orchestrator.createTask({
    name: '集成测试任务',
    description: '用于验证的基本任务',
    priority: 'medium',
    task_type: 'development',
    created_by: 'user_default',
  });
  assert(task.task_id, 'should have task_id');
  assert(task.name === '集成测试任务', 'name should match');
  assert(task.status === 'created', 'initial status should be created');
  assert(task.complex_flag === false, 'complex_flag should default to false');
  testTaskId = task.task_id;

  // 验证文件已创建
  const taskDir = path.join(ROOT, 'tasks', task.task_id);
  assert(fs.existsSync(taskDir), 'task directory should exist');
  assert(fs.existsSync(path.join(taskDir, 'task.json')), 'task.json should exist');
  assert(fs.existsSync(path.join(taskDir, 'conversation.md')), 'conversation.md should exist');
});

test('getTask 获取任务', () => {
  const task = orchestrator.getTask(testTaskId);
  assert(task, 'should find task');
  assert(task.task_id === testTaskId, 'task_id should match');
});

test('getTasks 获取任务列表（支持筛选）', () => {
  const tasks = orchestrator.getTasks();
  assert(Array.isArray(tasks), 'should return array');
  assert(tasks.some(t => t.task_id === testTaskId), 'should contain test task');

  const created = orchestrator.getTasks({ status: 'created' });
  assert(created.every(t => t.status === 'created'), 'all should have status created');
});

test('terminateTask 终止任务', async () => {
  const task = await orchestrator.terminateTask(testTaskId);
  assert(task.status === 'failed', 'should be failed after termination');
  assert(task.suspend_reason === '用户主动终止', 'should have suspend reason');
});

test('exportTasks 导出任务数据', () => {
  const data = orchestrator.exportTasks([testTaskId]);
  assert(Array.isArray(data), 'should return array');
  assert(data[0].task, 'should have task data');
  assert(data[0].conversation !== undefined, 'should have conversation');
});

test('deleteTasks 删除任务（需权限）', async () => {
  const result = await orchestrator.deleteTasks([testTaskId], 'user_default');
  assert(result.deleted.length === 1, 'should delete 1 task');
  assert(result.deleted[0].task_id === testTaskId, 'should delete correct task');

  // 验证目录已删除
  const taskDir = path.join(ROOT, '..', 'tasks', testTaskId);
  assert(!fs.existsSync(taskDir), 'task directory should be deleted');
});

test('deleteTasks 权限校验', async () => {
  // 创建任务并尝试用非创建人删除
  const t = await orchestrator.createTask({ name: '权限测试', description: 'test', created_by: 'user_default' });
  const result = await orchestrator.deleteTasks([t.task_id], 'user_other');
  assert(result.failed.length === 1, 'non-owner should not be able to delete');
  assert(result.failed[0].reason.includes('无权限'), 'should mention permission denied');

  // 清理：用 admin 删除
  await orchestrator.deleteTasks([t.task_id], 'user_default');
});

// 6. FeatureManager 文件持久化
console.log('\n【6. 特性文件持久化验证】');
const indexPath = path.join(ROOT, 'features', 'INDEX.md');
test('INDEX.md 存在', () => {
  assert(fs.existsSync(indexPath), 'INDEX.md should exist');
});

test('特性文件存在', () => {
  const featuresDir = path.join(ROOT, 'features');
  const featFiles = fs.readdirSync(featuresDir).filter(f => f.startsWith('feat_') && f.endsWith('.md'));
  assert(featFiles.length > 0, 'should have at least 1 feature file');
});

// 7. 前端文件
console.log('\n【7. 前端文件验证】');
const frontendPath = path.join(ROOT, 'frontend', 'index.html');
test('index.html 存在且包含必要元素', () => {
  assert(fs.existsSync(frontendPath), 'index.html should exist');
  const content = fs.readFileSync(frontendPath, 'utf8');
  assert(content.includes('AgentStatusPanel'), 'should have Agent status panel');
  assert(content.includes('TaskListPanel'), 'should have task list panel');
  assert(content.includes('ConversationPanel'), 'should have conversation panel');
  assert(content.includes('Analytics'), 'should have analytics module');
  assert(content.includes('WebSocket'), 'should have WebSocket integration');
  assert(content.includes('Markdown'), 'should have Markdown rendering');
});

// 8. API Server 框架验证
console.log('\n【8. API Server 框架验证】');
const apiServer = require('../src/api/server');
test('ApiServer 实例化', () => {
  assert(apiServer.app, 'should have express app');
  assert(apiServer.port, 'should have port');
  assert(apiServer.wss, 'should have WebSocket server');
});

// 9. Worktree Manager
console.log('\n【9. Git Worktree Manager】');
const worktreeManager = require('../src/worktree/manager');
test('WorktreeManager 实例化', () => {
  assert(worktreeManager.worktreeRoot, 'should have worktree root');
  assert(worktreeManager.autoCleanupDays === 7, 'autoCleanupDays should be 7');
});

test('listWorktrees 返回 worktree 列表', () => {
  const trees = worktreeManager.listWorktrees();
  assert(Array.isArray(trees), 'should return array');
});

// 总结
console.log('\n========== 验证完成 ==========');
console.log(`通过: ${passed} / ${passed + failed}`);
console.log(`失败: ${failed}`);
console.log('');

if (failed > 0) {
  console.log('失败的测试:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  - ${r.name}: ${r.error}`);
  });
  process.exit(1);
} else {
  console.log('所有测试通过！');
  process.exit(0);
}
