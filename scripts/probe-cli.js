#!/usr/bin/env node
/**
 * CLI resume 能力探测与准入
 *
 * 用法：
 *   node scripts/probe-cli.js                 # 仅解析 --help（不消耗 token）
 *   node scripts/probe-cli.js --functional    # 额外做一次真实两轮调用（会消耗 token）
 *   node scripts/probe-cli.js --cli claude    # 只探测指定 CLI
 *
 * 结果写入 config/cli-profiles.yaml 的 supported / probed_at / probe_detail。
 * supported=false 的 CLI 在运行时会被禁止调度（按项目策略排除该模型）。
 */

const { spawnSync } = require('child_process');
const capabilities = require('../src/adapters/contract/capabilities');

const CLI_NAMES = ['claude', 'qwen', 'kimi'];

function parseArgs(argv) {
  const out = { functional: false, cli: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--functional') out.functional = true;
    else if (argv[i] === '--cli') out.cli = argv[++i];
  }
  return out;
}

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function helpText(cmd) {
  const r = spawnSync(cmd, ['--help'], { encoding: 'utf8', timeout: 15000 });
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}

/** 基于 --help 判断 CLI 支持的 resume 相关参数 */
function detectFlags(help) {
  return {
    resume: /--resume\b/.test(help),
    sessionId: /--session-id\b/.test(help),
    continue: /--continue\b/.test(help),
  };
}

/**
 * 功能探测：两轮调用，第二轮带 resume，验证是否复用会话。
 * 只发极短 prompt，成本可控。
 */
function functionalProbe(cliPath, flags) {
  const first = spawnSync(cliPath, ['-p', '回答一个字：好'], { encoding: 'utf8', timeout: 120000 });
  if (first.status !== 0) {
    return { ok: false, detail: `首次调用失败: ${(first.stderr || '').slice(0, 200)}` };
  }
  if (!flags.resume) {
    return { ok: false, detail: 'help 中未发现 --resume' };
  }
  // 用法差异：有的 CLI 需要交互式选择，非交互下直接报错 → 视为不支持
  const second = spawnSync(cliPath, ['--resume', 'latest', '-p', '继续'], { encoding: 'utf8', timeout: 120000 });
  const err = `${second.stderr || ''}${second.stdout || ''}`;
  if (second.status !== 0) {
    return { ok: false, detail: `resume 调用失败: ${err.slice(0, 200)}` };
  }
  return { ok: true, detail: '两轮调用成功' };
}

function probeOne(name, opts) {
  const path = which(name);
  if (!path) {
    return { supported: false, detail: `${name} 不在 PATH 中`, path: null };
  }
  let help = '';
  try { help = helpText(path); } catch (e) { help = ''; }
  const flags = detectFlags(help);

  // 策略判定：优先 session-id（可预生成 id），否则 resume
  let supported = flags.sessionId || flags.resume;
  let detail = JSON.stringify(flags);

  if (opts.functional && supported) {
    const fp = functionalProbe(path, flags);
    supported = fp.ok;
    detail += ` | functional: ${fp.detail}`;
  }

  return { supported, detail, path, flags };
}

function main() {
  const opts = parseArgs(process.argv);
  const names = opts.cli ? [opts.cli] : CLI_NAMES;
  const results = [];

  for (const name of names) {
    const r = probeOne(name, opts);
    results.push({ name, ...r });
    console.log(`[probe] ${name}: ${r.supported ? 'SUPPORTED' : 'UNSUPPORTED'} — ${r.detail}`);
    if (r.path) console.log(`        path: ${r.path}`);
  }

  // deepseek 复用 qwen 的能力
  const qwen = results.find(r => r.name === 'qwen');
  if (qwen && !opts.cli) {
    capabilities.recordProbe('deepseek', {
      supported: qwen.supported,
      detail: 'inherit from qwen: ' + qwen.detail,
    });
    console.log(`[probe] deepseek: ${qwen.supported ? 'SUPPORTED' : 'UNSUPPORTED'}（继承 qwen）`);
  }

  for (const r of results) {
    capabilities.recordProbe(r.name, { supported: r.supported, detail: r.detail });
  }

  const excluded = results.filter(r => !r.supported).map(r => r.name);
  console.log('');
  console.log('=== CLI 准入报告 ===');
  for (const r of results) {
    console.log(`${r.name.padEnd(8)} ${r.supported ? '准入' : '排除'}  ${r.detail}`);
  }
  if (excluded.length) {
    console.log(`\n未通过准入的 CLI：${excluded.join(', ')} —— 请从 config/agents.yaml 中禁用对应 Agent。`);
  }
  console.log('\n结果已写入 config/cli-profiles.yaml');
}

main();
