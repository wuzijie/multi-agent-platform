const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ModelLogger = require('../utils/model-logger');
const { streamChatCompletion } = require('./openai-sse');

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
      if (fs.existsSync(path.join(candidate, '.deepseek'))) {
        return candidate;
      }
    }
  }
  return os.homedir();
}

/**
 * 迪普斯克 (DeepSeek) 适配器
 *
 * 由于没有独立的 DeepSeek CLI，复用 Qwen Code CLI 作为运行时，
 * 通过 Qwen Code CLI 的 OpenAI 兼容模式调用 DeepSeek API。
 *
 * 调用方式：qwen -p "prompt" -o text -m deepseek-v4-flash
 */
class DeepSeekAdapter {
  constructor() {
    this.name = 'DeepSeekAdapter';
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
    // 惰性加载兜底：若配置尚未加载（如独立调用入口遗漏 loadAll），自动补加载
    if (this._config && (!this._config.apiKeys || Object.keys(this._config.apiKeys).length === 0)) {
      try { this._config.loadAll(); } catch (e) { /* 忽略重复加载错误 */ }
    }
    return this._config;
  }

  _getApiKey() {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.deepseek_api_key) return cfg.apiKeys.deepseek_api_key;
    return null;
  }

  _getBaseUrl() {
    if (process.env.OPENAI_BASE_URL) return process.env.OPENAI_BASE_URL;
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.deepseek_base_url) return cfg.apiKeys.deepseek_base_url;
    return 'https://api.deepseek.com/v1';
  }

  _getModel() {
    if (process.env.DEEPSEEK_MODEL) return process.env.DEEPSEEK_MODEL;
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.deepseek_model) return cfg.apiKeys.deepseek_model;
    return 'deepseek-v4-flash'; // 兜底默认：调用 DeepSeek 只用 v4-flash
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

  async execute(input, onChunk) {
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

    const model = this._getModel();
    ModelLogger.logRequest(this.name, model, fullPrompt);

    const promptLength = fullPrompt.length;
    // 下限 240 秒：慢模型完成长任务常超过 60 秒。
    // 调度器子任务预算 300 秒，适配器需在其内自行返回，避免被 spawn timeout 提前杀死。
    const timeoutMs = Math.max(240000, promptLength * 2 + 30000);

    // 优先：直连 OpenAI 兼容 API 实现真流式（qwen CLI 会缓冲输出）
    const apiKey = this._getApiKey();
    const baseUrl = this._getBaseUrl();
    if (apiKey && baseUrl) {
      try {
        const streamed = await streamChatCompletion({
          baseUrl,
          apiKey,
          model,
          messages: [{ role: 'user', content: fullPrompt }],
          timeoutMs,
          onChunk,
        });
        if (streamed.ok && streamed.text) {
          ModelLogger.logResponse(this.name, model, streamed.text);
          return buildOutput(input.task_id, 'success', streamed.text, {
            tokens_used: this._estimateTokens(streamed.text),
            duration_ms: Date.now() - startTime,
          });
        }
        if (streamed.ok && !streamed.text) {
          ModelLogger.logResponse(this.name, model, '(空响应)');
          return buildOutput(input.task_id, 'failed', '', {
            error: { code: 'EMPTY_RESPONSE', message: 'API 返回空内容' },
            duration_ms: Date.now() - startTime,
          });
        }
        // API 直连超时：CLI 走的是同一 API，回退只会再耗一轮，直接按超时失败（走调度器重试）
        if (streamed.error && streamed.error.includes('超时')) {
          ModelLogger.logResponse(this.name, model, `[API直连超时，直接失败] ${streamed.error}`);
          return buildOutput(input.task_id, 'failed', '', {
            error: { code: 'TIMEOUT', message: streamed.error },
            duration_ms: Date.now() - startTime,
          });
        }
        // API 直连失败（非超时）→ 回退 CLI 路径
        ModelLogger.logResponse(this.name, model, `[API直连失败，回退CLI] ${streamed.error || ''}`);
      } catch (apiErr) {
        ModelLogger.logResponse(this.name, model, `[API直连异常，回退CLI] ${apiErr.message}`);
      }
    }

    try {
      const result = await this._runCli(['-p', '-o', 'text'], fullPrompt, timeoutMs, model, onChunk);

      if (result.exit_code === 0) {
        ModelLogger.logResponse(this.name, model, result.stdout);
        return buildOutput(input.task_id, 'success', result.stdout, {
          tokens_used: this._estimateTokens(result.stdout),
          duration_ms: Date.now() - startTime,
        });
      } else {
        let errMsg;
        let errorCode = 'CLI_ERROR';
        if (result.killed_by_timeout) {
          errorCode = 'TIMEOUT';
          errMsg = `模型调用超时（超过 ${Math.round(timeoutMs / 1000)} 秒无结果，进程已被中断）`;
        } else {
          errMsg = result.stderr || result.stdout || 'Unknown error';
          if (errMsg.includes('Not logged in') || errMsg.includes('login')) {
            errorCode = 'AUTH_REQUIRED';
          } else if (errMsg.includes('timeout')) {
            errorCode = 'TIMEOUT';
          }
        }
        ModelLogger.logResponse(this.name, model, errMsg);
        return buildOutput(input.task_id, 'failed', result.stdout || '', {
          error: { code: errorCode, message: errMsg.substring(0, 500) },
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
      `你是一个多智能体协作平台中的${roleLabel}智能体（迪普斯克，由 DeepSeek 驱动）。`,
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

  _runCli(args, prompt, timeoutMs, modelOverride, onChunk) {
    return new Promise((resolve) => {
      const startAt = Date.now();
      let stdout = '';
      let stderr = '';
      let streamedLen = 0;

      // Build args: inject prompt after -p, add model
      const finalArgs = [];
      for (let i = 0; i < args.length; i++) {
        finalArgs.push(args[i]);
        if (args[i] === '-p' && prompt) {
          finalArgs.push(prompt);
        }
      }

      const model = modelOverride || this._getModel();
      if (model && model !== 'deepseek-default') {
        finalArgs.push('-m', model);
      }

      const apiKey = this._getApiKey();
      const baseUrl = this._getBaseUrl();
      const envVars = {
        ...process.env,
        HOME: this.realHome,
      };
      if (apiKey) envVars.OPENAI_API_KEY = apiKey;
      if (baseUrl) envVars.OPENAI_BASE_URL = baseUrl;

      const proc = spawn(this.cliCommand, finalArgs, {
        cwd: ROOT,
        env: envVars,
        timeout: timeoutMs || 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (typeof onChunk === 'function') {
          const added = stdout.length - streamedLen;
          if (added > 0) {
            streamedLen = stdout.length;
            onChunk(stdout.substring(streamedLen - added));
          }
        }
      });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        resolve({
          exit_code: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          // code === null 表示被信号杀死（spawn timeout 会 SIGTERM 杀掉进程）
          killed_by_timeout: code === null || Date.now() - startAt >= (timeoutMs || 120000) - 500,
        });
      });

      proc.on('error', (err) => {
        resolve({
          exit_code: -1,
          stdout: stdout.trim(),
          stderr: err.message,
          killed_by_timeout: false,
        });
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

module.exports = { DeepSeekAdapter, validateInput, buildOutput };
