const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ModelLogger = require('../utils/model-logger');

const ROOT = path.resolve(__dirname, '..', '..');

function validateInput(input) {
  const required = ['task_id', 'role', 'context', 'instruction'];
  for (const field of required) {
    if (!input[field]) {
      throw new Error(`Missing required field in UnifiedInput: ${field}`);
    }
  }
  if (!['executor', 'reviewer', 'guardian'].includes(input.role)) {
    throw new Error(`Invalid role: ${input.role}`);
  }
  return input;
}

function buildOutput(taskId, status, content, opts = {}) {
  return {
    task_id: taskId,
    status,
    content: content || '',
    output_files: opts.output_files || [],
    error: opts.error || null,
    tokens_used: opts.tokens_used || 0,
    duration_ms: opts.duration_ms || 0,
  };
}

function detectRealHome() {
  if (process.env.HOST_HOME && fs.existsSync(process.env.HOST_HOME)) {
    return process.env.HOST_HOME;
  }
  const usersDir = '/Users';
  if (fs.existsSync(usersDir)) {
    const users = fs.readdirSync(usersDir).filter(u => !u.startsWith('.') && u !== 'Shared');
    for (const user of users) {
      const candidate = path.join(usersDir, user);
      if (fs.existsSync(path.join(candidate, '.qwen'))) {
        return candidate;
      }
    }
  }
  return os.homedir();
}

/**
 * 钱文 (Qwen Code CLI) 适配器
 *
 * CLI: qwen (npm: @qwen-code/qwen-code)
 * 调用方式：qwen -p "prompt" -o text -m <model>
 *
 * 参数说明：
 *   -p, --prompt         非交互模式，直接执行提示词
 *   -o, --output-format   输出格式: text | json | stream-json
 *   -m, --model          指定模型
 *   -s, --sandbox         沙箱模式（留空，我们手动管理）
 */
class QwenAdapter {
  constructor() {
    this.name = 'QwenAdapter';
    this.cliCommand = this._findCliPath() || 'qwen';
    this.realHome = detectRealHome();
    this._config = null;
  }

  _findCliPath() {
    const candidates = [];
    const home = detectRealHome();

    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, '.npm-global', 'bin', 'qwen'));
    }
    candidates.push('/usr/local/bin/qwen');
    candidates.push(path.join(home, '.npm-global', 'bin', 'qwen'));
    candidates.push('/opt/homebrew/bin/qwen');

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  _getConfig() {
    if (!this._config) {
      this._config = require('../utils/config');
    }
    return this._config;
  }

  _getApiKey() {
    if (process.env.QWEN_API_KEY) return process.env.QWEN_API_KEY;
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.qwen_api_key) return cfg.apiKeys.qwen_api_key;
    return null;
  }

  _getBaseUrl() {
    if (process.env.QWEN_BASE_URL) return process.env.QWEN_BASE_URL;
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.qwen_base_url) return cfg.apiKeys.qwen_base_url;
    return null;
  }

  _getModel() {
    if (process.env.QWEN_MODEL) return process.env.QWEN_MODEL;
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.qwen_model) return cfg.apiKeys.qwen_model;
    return null;
  }

  getName() {
    return this.name;
  }

  async healthCheck() {
    const start = Date.now();
    try {
      const result = await this._runCli(['--version'], '', 10000);
      return {
        online: result.exit_code === 0,
        latency_ms: Date.now() - start,
        version: result.stdout.trim(),
      };
    } catch (e) {
      return {
        online: false,
        latency_ms: Date.now() - start,
        error: e.message,
      };
    }
  }

  async execute(input) {
    validateInput(input);
    const startTime = Date.now();

    const prompt = this._buildPrompt(input);
    let fullPrompt = prompt;
    if (input.input_files && input.input_files.length > 0) {
      const fileContents = input.input_files.map(f => {
        const filePath = path.isAbsolute(f) ? f : path.join(ROOT, f);
        if (fs.existsSync(filePath)) {
          return `\n\n=== 文件: ${f} ===\n${fs.readFileSync(filePath, 'utf8')}`;
        }
        return `\n\n=== 文件 ${f} 不存在 ===`;
      }).join('\n');
      fullPrompt += fileContents;
    }

    const model = this._getModel() || process.env.QWEN_MODEL || 'qwen-default';
    ModelLogger.logRequest(this.name, model, fullPrompt);

    const promptLength = fullPrompt.length;
    const timeoutMs = Math.max(60000, promptLength * 2 + 30000);

    try {
      const result = await this._runCli(['-p', '-o', 'text'], fullPrompt, timeoutMs, model);

      if (result.exit_code === 0) {
        ModelLogger.logResponse(this.name, model, result.stdout);
        return buildOutput(input.task_id, 'success', result.stdout, {
          tokens_used: this._estimateTokens(result.stdout),
          duration_ms: Date.now() - startTime,
        });
      } else {
        const errMsg = result.stderr || result.stdout || 'Unknown error';
        ModelLogger.logResponse(this.name, model, errMsg);
        return buildOutput(input.task_id, 'failed', result.stdout || '', {
          error: { code: 'CLI_ERROR', message: errMsg.substring(0, 500) },
          duration_ms: Date.now() - startTime,
        });
      }
    } catch (e) {
      ModelLogger.logResponse(this.name, model, e.message);
      return buildOutput(input.task_id, 'failed', '', {
        error: { code: 'EXECUTION_ERROR', message: e.message },
        duration_ms: Date.now() - startTime,
      });
    }
  }

  _buildPrompt(input) {
    const roleLabel = {
      'executor': '执行者',
      'reviewer': '评审者',
      'guardian': '愿景守护者',
    }[input.role] || input.role;

    const lines = [
      `你是一个多智能体协作平台中的${roleLabel}智能体（钱文）。`,
      '',
      '## 任务ID',
      input.task_id,
      '',
      '## 任务背景',
      input.context,
      '',
      '## 执行指令',
      input.instruction,
      '',
      '## 要求',
      '- 请根据以上指令完成你的工作',
      '- 直接输出结果内容，不需要多余的说明',
      '- 如果任务涉及代码，请确保代码可以正常运行',
      '- 如果任务不可行，请明确说明原因',
    ];
    return lines.join('\n');
  }

  _runCli(args, prompt, timeoutMs, modelOverride) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      // Construct final args: args already has ['-p', '-o', 'text']
      // We need to inject the prompt value after -p
      const finalArgs = [];
      for (let i = 0; i < args.length; i++) {
        finalArgs.push(args[i]);
        if (args[i] === '-p' && prompt) {
          finalArgs.push(prompt);
        }
      }
      if (args[0] !== '-p' && prompt) {
        // If -p wasn't first, add it
        finalArgs.unshift(prompt);
        finalArgs.unshift('-p');
      }

      // Add model flag if configured
      const model = modelOverride || this._getModel();
      if (model && model !== 'qwen-default') {
        finalArgs.push('-m', model);
      }

      const apiKey = this._getApiKey();
      const baseUrl = this._getBaseUrl();
      const envVars = {
        ...process.env,
        HOME: this.realHome,
      };
      // Qwen Code CLI 使用 OpenAI-compatible 认证方式
      if (apiKey) envVars.OPENAI_API_KEY = apiKey;
      if (baseUrl) envVars.OPENAI_BASE_URL = baseUrl;

      const proc = spawn(this.cliCommand, finalArgs, {
        cwd: ROOT,
        env: envVars,
        timeout: timeoutMs || 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        resolve({ exit_code: code, stdout: stdout.trim(), stderr: stderr.trim() });
      });

      proc.on('error', (err) => {
        resolve({ exit_code: -1, stdout: stdout.trim(), stderr: err.message });
      });
    });
  }

  _estimateTokens(text) {
    if (!text) return 0;
    const chineseChars = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars + otherChars / 3);
  }
}

module.exports = { QwenAdapter, validateInput, buildOutput };
