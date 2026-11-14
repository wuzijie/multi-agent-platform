#!/usr/bin/env node
/**
 * CLI 思考/推理内容（thinking / reasoning）探测 —— P0 只读
 *
 * 目的：摸清四个 CLI 的 stream-json 输出里，
 *   - 思考内容出现在哪个字段（thinking_delta / thinking / think / reasoning_content）
 *   - 默认是否输出思考、需要什么 flag 才输出
 *   - 是否真流式（增量到达）还是缓冲成一整块
 *
 * 用法：
 *   node scripts/probe-thinking.js                    # 探测 claude / qwen / kimi / deepseek
 *   node scripts/probe-thinking.js --cli qwen         # 只探测 qwen
 *   node scripts/probe-thinking.js --prompt "..."     # 自定义推理题
 *   node scripts/probe-thinking.js --no-extra         # 只跑默认 stream-json，不跑 thinking 变体
 *
 * prompt 通过 stdin 传给 CLI（Claude Code 2.x 等新版 CLI 在非交互模式优先读 stdin，
 * 位置参数 prompt 已被降级/忽略）。
 *
 * 结果落盘 logs/probe-thinking/{cli}[-variant].jsonl（stdout）与 .stderr.txt（stderr），
 * 控制台打印摘要。不写回任何配置、不修改任何运行态。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'logs', 'probe-thinking');
const config = require('../src/utils/config');
try { config.loadAll(); } catch (e) { /* ignore */ }

const DEFAULT_PROMPT =
  '请一步一步推理回答：一个水池有 A、B 两根水管，A 管 3 小时注满，B 管 6 小时放空。' +
  '两管同时打开，多久能注满？先写出你的思考过程，再给出最终答案。';
const TIMEOUT_MS = 180000;

function parseArgs(argv) {
  const out = { cli: null, prompt: DEFAULT_PROMPT, extra: true };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--cli') out.cli = argv[++i];
    else if (argv[i] === '--prompt') out.prompt = argv[++i];
    else if (argv[i] === '--no-extra') out.extra = false;
  }
  return out;
}

function pick(src, mapping) {
  const out = {};
  for (const k of Object.keys(mapping)) {
    if (src[k]) out[mapping[k]] = src[k];
  }
  return out;
}

/** 各 CLI 的 flags（不含 prompt，prompt 走 stdin）+ 额外 thinking 变体 */
function cliDefs() {
  const api = config.apiKeys || {};
  const HOME = process.env.HOST_HOME || os.homedir();
  return [
    {
      name: 'claude',
      command: 'claude',
      env: Object.assign({ HOME }, pick(api, {
        anthropic_api_key: 'ANTHROPIC_API_KEY',
        anthropic_base_url: 'ANTHROPIC_BASE_URL',
        model_override: 'ANTHROPIC_MODEL',
      })),
      flags: ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--add-dir', ROOT, '--bare'],
      variants: [
        { label: 'thinking-summarized', flags: ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--add-dir', ROOT, '--bare', '--thinking-display', 'summarized'] },
      ],
    },
    {
      name: 'qwen',
      command: 'qwen',
      env: Object.assign({ HOME }, pick(api, {
        qwen_api_key: 'OPENAI_API_KEY',
        qwen_base_url: 'OPENAI_BASE_URL',
      })),
      flags: ['-p', '-o', 'stream-json'],
      variants: [
        { label: 'reasoner', flags: ['-p', '-o', 'stream-json', '-m', 'deepseek-reasoner'] },
      ],
    },
    {
      name: 'deepseek', // 复用 qwen CLI，走 DeepSeek 的 OpenAI 兼容接口
      command: 'qwen',
      env: Object.assign({ HOME }, pick(api, { deepseek_api_key: 'OPENAI_API_KEY' }), {
        OPENAI_BASE_URL: api.deepseek_base_url || 'https://api.deepseek.com/v1',
      }),
      flags: ['-p', '-o', 'stream-json', '-m', api.deepseek_model || 'deepseek-v4-flash'],
      variants: [
        { label: 'reasoner', flags: ['-p', '-o', 'stream-json', '-m', 'deepseek-reasoner'] },
      ],
    },
    {
      name: 'kimi',
      command: 'kimi',
      env: Object.assign({ HOME }, pick(api, { kimi_api_key: 'KIMI_API_KEY' })),
      flags: ['-p', '--output-format=stream-json', '--add-dir', ROOT],
      variants: [
        { label: 'thinking-effort-high', env: { KIMI_MODEL_THINKING_EFFORT: 'high' }, flags: ['-p', '--output-format=stream-json', '--add-dir', ROOT] },
      ],
    },
  ];
}

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** 跑一次 CLI：prompt 通过 stdin 写入，逐行记相对时间戳并落盘 stdout/stderr */
function runOnce(def, prompt, variant) {
  return new Promise((resolve) => {
    const cmdPath = which(def.command);
    if (!cmdPath) {
      resolve({ ok: false, error: `${def.command} 不在 PATH 中` });
      return;
    }
    const safe = `${def.name}${variant ? '-' + variant.label : ''}`;
    const outPath = path.join(OUT_DIR, `${safe}.jsonl`);
    const errPath = path.join(OUT_DIR, `${safe}.stderr.txt`);
    const w = fs.createWriteStream(outPath, { flags: 'w' });

    const flags = variant ? variant.flags : def.flags;
    const env = Object.assign({}, process.env, def.env, variant ? variant.env : {}, {
      PATH: [path.dirname(cmdPath), process.env.PATH || ''].join(':'),
    });

    const startAt = Date.now();
    const proc = spawn(cmdPath, flags, {
      cwd: ROOT, env, timeout: TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // prompt 通过 stdin 传（新版 CLI 非交互模式主要从 stdin 读）
    proc.stdin.write(prompt + '\n');
    proc.stdin.end();

    let buf = '';
    let stderr = '';
    let lines = 0;
    const arrivals = [];
    const flush = (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const atMs = Date.now() - startAt;
        arrivals.push(atMs);
        lines += 1;
        w.write(JSON.stringify({ _at_ms: atMs, _raw: line }) + '\n');
      }
    };

    proc.stdout.on('data', flush);
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (buf.trim()) {
        const atMs = Date.now() - startAt;
        arrivals.push(atMs);
        lines += 1;
        w.write(JSON.stringify({ _at_ms: atMs, _raw: buf }) + '\n');
      }
      w.end();
      if (stderr.trim()) fs.writeFileSync(errPath, stderr);
      resolve({ ok: code === 0, exit: code, lines, arrivals, stderr: stderr.trim().slice(0, 500), errPath, outPath });
    });
    proc.on('error', (err) => {
      w.end();
      resolve({ ok: false, error: err.message, lines, arrivals, errPath, outPath });
    });
  });
}

/** 递归收集 JSON 里所有「思考相关」字段与「文本」字段 */
function scanFields(node, pathStr, acc) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanFields(v, `${pathStr}[${i}]`, acc));
    return;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) scanFields(node[k], pathStr ? `${pathStr}.${k}` : k, acc);
    return;
  }
  if (typeof node !== 'string') return;
  const lower = pathStr.toLowerCase();
  const bucket = /think|reason/.test(lower) ? 'thinking'
    : /text|delta/.test(lower) ? 'text'
    : null;
  if (!bucket) return;
  if (!acc[bucket][pathStr]) acc[bucket][pathStr] = { count: 0, chars: 0, sample: '' };
  const rec = acc[bucket][pathStr];
  rec.count += 1;
  rec.chars += node.length;
  if (!rec.sample && node.trim()) rec.sample = node.trim().slice(0, 60);
}

/** 读落盘 jsonl，扫描字段 + 流式特征 */
function summarize(run) {
  if (!run.ok && run.error) return { error: run.error };
  const scan = { thinking: {}, text: {} };
  const types = {};
  let parsed = 0;
  try {
    const raw = fs.readFileSync(run.outPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch (e) { continue; }
      let obj; try { obj = JSON.parse(rec._raw); } catch (e) { continue; }
      parsed += 1;
      if (obj && typeof obj === 'object' && obj.type) types[obj.type] = (types[obj.type] || 0) + 1;
      scanFields(obj, '', scan);
    }
  } catch (e) { return { error: e.message }; }

  const arr = run.arrivals || [];
  const firstMs = arr[0] ?? null;
  const lastMs = arr.length ? arr[arr.length - 1] : null;
  return {
    parsed, types, scan,
    firstMs, lastMs,
    spreadMs: (firstMs != null && lastMs != null) ? lastMs - firstMs : null,
  };
}

function fmtSummary(s) {
  if (s.error) return `  失败: ${s.error}`;
  const tk = Object.keys(s.scan.thinking);
  const tx = Object.keys(s.scan.text);
  const tkTotal = tk.reduce((n, k) => n + s.scan.thinking[k].count, 0);
  const txTotal = tx.reduce((n, k) => n + s.scan.text[k].count, 0);
  const out = [
    `JSON 行 ${s.parsed} | 首块 ${s.firstMs}ms | 末块 ${s.lastMs}ms | 跨度 ${s.spreadMs}ms`,
    `类型: ${JSON.stringify(s.types)}`,
    `思考字段 ${tkTotal} 处: ${tk.length ? tk.map(k => `${k}×${s.scan.thinking[k].count}`).join(', ') : '（无）'}`,
    `文本字段 ${txTotal} 处: ${tx.length ? tx.map(k => `${k}×${s.scan.text[k].count}`).join(', ') : '（无）'}`,
  ];
  for (const k of tk) out.push(`  · ${k} 样例: ${s.scan.thinking[k].sample || '(空)'}`);
  return out.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv);
  const defs = cliDefs().filter((d) => !opts.cli || d.name === opts.cli);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`\n【思考内容探测】prompt: ${opts.prompt.slice(0, 40)}${opts.prompt.length > 40 ? '…' : ''}`);
  console.log(`输出目录: ${OUT_DIR}`);

  for (const def of defs) {
    console.log(`\n=== ${def.name} (${def.command}) ===`);
    const variants = [{ label: null, flags: def.flags }];
    if (opts.extra) for (const v of def.variants || []) variants.push(v);
    for (const v of variants) {
      console.log(`--- ${v.label || '默认'} ---`);
      const run = await runOnce(def, opts.prompt, v.label ? v : null);
      console.log(fmtSummary(summarize(run)));
      if (run.stderr) console.log(`  stderr: ${run.stderr}`);
    }
  }

  console.log('\n=== 完成 ===');
  console.log('原始输出已落盘（.jsonl = stdout，.stderr.txt = stderr），人工打开日志确认字段名 / 是否真流式即可。');
}

main().catch((e) => { console.error(e); process.exit(1); });
