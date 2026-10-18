/**
 * Prompt 上下文注入回归测试
 *
 * 核心不变量：
 *   第 N 轮完整 prompt 必须是第 N+1 轮完整 prompt 的严格前缀（纯文本聊天）。
 *   含工具调用的轮次同样成立（工具结果追加在尾部）。
 *
 * 运行：node tests/prompt-context.test.js
 */
const fs = require('fs');
const path = require('path');
const runtime = require('../src/agent/runtime');
const registry = require('../src/tools/registry');
const transcript = require('../src/prompt/transcript');
const { buildPrompt } = require('../src/adapters/prompt-template');

const ROOT = path.resolve(__dirname, '..');
const TID = `__prompt_test_${Date.now()}`;
const TID2 = `${TID}_compact`;
const TID3 = `${TID}_tool`;
const TID4 = `${TID}_stable`;

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

function makePrompt(input) {
  return buildPrompt({
    agentLabel: '克劳德',
    role: input.role,
    taskId: input.task_id,
    context: input.context,
    instruction: input.instruction,
  });
}

function installFakeAgent(responses) {
  let index = 0;
  const inputs = [];
  runtime.agents.set('克劳德', {
    name: '克劳德',
    online: true,
    busy: false,
    _busyCount: 0,
    adapter: {
      async execute(input) {
        inputs.push(input);
        const content = typeof responses === 'function' ? responses(index) : responses[index];
        index += 1;
        return {
          task_id: input.task_id,
          status: 'success',
          content: content || '',
          output_files: [],
          tokens_used: 0,
          duration_ms: 0,
        };
      },
    },
  });
  return inputs;
}

function chatTask(instruction, historySegments) {
  return {
    task_id: TID,
    external_task_id: TID,
    role: 'executor',
    instruction,
    history_segments: historySegments || [],
    stable_context: '## 团队协作\n团队规则\n\n## 会话目标\n第一轮：写一个快排',
    chat_mode: true,
    record_transcript: true,
    disableTools: true,
  };
}

async function testChatPrefix() {
  console.log('\n[1] 纯文本聊天：第二轮 prompt 以第一轮为严格前缀');
  transcript.clear(TID);

  const inputs = installFakeAgent(['第一轮回答：function quickSort(){}']);

  await runtime.executeTaskWithAgent(chatTask('第一轮：写一个快排'), [], '克劳德');
  const p1 = makePrompt(inputs[0]);

  const history1 = transcript.loadSegments(TID);
  assert(history1.length === 2, '第一轮转录写入 2 段（用户 + 助手）', JSON.stringify(history1));

  await runtime.executeTaskWithAgent(chatTask('第二轮：把刚才的代码改成 Python', history1), [], '克劳德');
  const p2 = makePrompt(inputs[1]);

  assert(p2.startsWith(p1), '第 2 轮 prompt 以第 1 轮 prompt 为前缀');
  assert(p2.includes('第一轮回答：function quickSort(){}'), '第 2 轮 prompt 包含上一轮回复全文');
  assert(p2.includes('第二轮：把刚才的代码改成 Python'), '第 2 轮 prompt 包含当前问题');
  if (!p2.startsWith(p1)) {
    console.error('--- p1 尾部 ---\n' + p1.slice(-200));
    console.error('--- p2 对应位置 ---\n' + p2.slice(p1.length - 200, p1.length + 200));
  }
}

async function testCompaction() {
  console.log('\n[2] 转录压缩：超阈值时一次性重写');
  transcript.clear(TID2);
  for (let i = 0; i < 10; i++) {
    transcript.appendSegments(TID2, [`[用户] 第${i}轮问题 ${'x'.repeat(800)}`]);
  }
  const segments = transcript.loadSegments(TID2, { compact_threshold: 3000, recent_turns_after_compact: 1, max_chars: 100000 });
  assert(segments.length === 3, '压缩后保留「省略标记 + 最近 2 段」');
  assert(segments[0].includes('已省略'), '首段为省略标记');
  const raw = fs.readFileSync(transcript.transcriptPath(TID2), 'utf8').trim().split('\n');
  assert(raw.length === 3, '压缩结果已回写文件（后续轮次前缀稳定）');
}

async function testToolPrefix() {
  console.log('\n[3] 工具调用轮：prompt 仍为追加式');
  transcript.clear(TID3);

  const original = {
    getToolPrompt: registry.getToolPrompt,
    parseToolCallsFromText: registry.parseToolCallsFromText,
    execute: registry.execute,
  };
  registry.getToolPrompt = () => '你可以调用以下工具：fake_tool';
  registry.parseToolCallsFromText = (content) => (
    String(content).includes('[TOOL_CALL]')
      ? { tool_calls: [{ name: 'fake_tool', arguments: {} }], remaining: '我先查一下资料。' }
      : null
  );
  registry.execute = async () => 'RESULT_FROM_TOOL';

  try {
    const inputs = installFakeAgent([
      '我先查一下资料。\n[TOOL_CALL]{"name":"fake_tool","arguments":{}}[/TOOL_CALL]',
      '最终回答',
    ]);
    const task = {
      task_id: TID3,
      external_task_id: TID3,
      role: 'executor',
      instruction: '查一下资料',
      history_segments: [],
      stable_context: '## 会话目标\n查一下资料',
      chat_mode: true,
      record_transcript: true,
    };
    await runtime.executeTaskWithAgent(task, [], '克劳德');

    const p0 = makePrompt(inputs[0]);
    const p1 = makePrompt(inputs[1]);
    assert(p1.startsWith(p0), '工具回灌轮 prompt 以首轮 prompt 为前缀');
    assert(p1.includes('RESULT_FROM_TOOL'), '工具结果进入追加尾部');
    assert(p1.includes('我先查一下资料。'), '模型上一轮已生成文本被保留');
  } finally {
    registry.getToolPrompt = original.getToolPrompt;
    registry.parseToolCallsFromText = original.parseToolCallsFromText;
    registry.execute = original.execute;
  }
}

async function testNonChat() {
  console.log('\n[4] 非聊天路径（DAG 子任务）：不注入对话，只带任务上下文');
  const inputs = installFakeAgent(['ok']);
  await runtime.executeTaskWithAgent({
    task_id: 'sub_001',
    external_task_id: TID,
    role: 'executor',
    instruction: '执行子任务',
    context: '原始请求: 写一个快排',
    disableTools: true,
  }, [], '克劳德');

  const prompt = makePrompt(inputs[0]);
  assert(prompt.includes('原始请求: 写一个快排'), '包含任务上下文');
  assert(!prompt.includes('## 对话'), '不包含对话区（子任务保持隔离）');
}

async function testStableContext() {
  console.log('\n[5] 稳定上下文：跨轮不变、记忆冻结、运行态字段不落盘');
  const config = require('../src/utils/config');
  config.loadAll();
  const orchestrator = require('../src/orchestrator/orchestrator');

  const task = {
    task_id: TID4,
    name: '测试任务',
    description: '第二轮问题',
    memory_context: '记忆ABC',
  };
  const stable1 = orchestrator._buildStableContext(task, '第一轮问题');
  const stable2 = orchestrator._buildStableContext(task, '第二轮问题');
  assert(stable1 === stable2, '同一会话内稳定上下文逐字节一致');
  assert(stable1.includes('记忆ABC'), '长期记忆已冻结进稳定上下文');
  assert(stable1.includes('## 会话目标\n第一轮问题'), '会话目标固定为首轮问题');

  // 运行态字段不落盘
  const dir = path.join(ROOT, 'tasks', TID4);
  fs.mkdirSync(dir, { recursive: true });
  task.stable_context = stable1;
  task.history_segments = ['[用户] 第一轮问题'];
  task.record_transcript = true;
  orchestrator._saveTask(task);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  assert(saved.history_segments === undefined, 'history_segments 不写入 task.json');
  assert(saved.stable_context === undefined, 'stable_context 不写入 task.json');
  assert(saved.memory_context === undefined, 'memory_context 不写入 task.json');
  assert(saved.frozen_memory === '记忆ABC', 'frozen_memory 持久化');
  assert(saved.session_goal === '第一轮问题', 'session_goal 持久化');
}

(async () => {
  try {
    await testChatPrefix();
    await testCompaction();
    await testToolPrefix();
    await testNonChat();
    await testStableContext();
  } finally {
    transcript.clear(TID);
    transcript.clear(TID2);
    transcript.clear(TID3);
    try { fs.rmSync(path.join(ROOT, 'tasks', TID), { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try { fs.rmSync(path.join(ROOT, 'tasks', TID2), { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try { fs.rmSync(path.join(ROOT, 'tasks', TID3), { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try { fs.rmSync(path.join(ROOT, 'tasks', TID4), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
  process.exit(0);
})();
