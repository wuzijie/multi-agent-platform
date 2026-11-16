const { spawn } = require('child_process');
const procRegistry = require('../utils/proc-registry');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ModelLogger = require('../utils/model-logger');
const { buildPrompt } = require('./prompt-template');
const capabilities = require('./contract/capabilities');
const { ERROR_CODE, SESSION_MISSING_PATTERNS } = require('./contract/enums');
const { validateUnifiedInput: validateInput } = require('./contract/validate');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * 统一输入格式验证（见 contract/validate.js）
 */

function buildOutput(taskId, status, content, opts = {}) {
  return {
    task_id: taskId,
    status,
    content: content || '',
    output_files: opts.output_files || [],
    error: opts.error || null,
    tokens_used: opts.tokens_used || 0,
    duration_ms: opts.duration_ms || 0,
    session_id: opts.session_id || null,
    reasoning: opts.reasoning || '',
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
    // 每次调用都重新加载（防止运行中改了 api_keys.yaml 但进程缓存旧值）
    try { this._config.loadAll(); } catch (e) { /* 忽略重复加载错误 */ }
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

  async execute(input, onChunk, onReasoning) {
    validateInput(input);
    const startTime = Date.now();
    this._capturedSessionId = null;
    this._capturedReasoning = '';
    this._reasoningSet = new Set();
    const session = input.session || {};

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
    // 请求链路追踪元信息
    const meta = {
      task_id: input.task_id || '',
      trace_id: input.trace_id || '',
      external_task_id: input.external_task_id || '',
      agent_name: input.agent_name || '',
      phase: input.phase || 'initial',
      attempt: input.attempt || 1,
    };
    const requestId = ModelLogger.logRequest(this.name, model, fullPrompt, meta);

    const promptLength = fullPrompt.length;
    // 下限 240 秒：慢模型完成长任务常超过 60 秒。
    // 调度器子任务预算 300 秒，适配器需在其内自行返回，避免被 spawn timeout 提前杀死。
    const timeoutMs = Math.max(240000, promptLength * 2 + 30000);

    // 仅走 CLI（不直连 API）：CLI 内部对接对应 API
    try {
      // resume 参数统一来自能力声明，不在此硬编码
      const sessionArgs = (session.enabled === false || !session.id)
        ? []
        : capabilities.buildResumeArgs('qwen', {
            sessionId: session.id,
            isFirstCall: !!session.is_first,
          });
      const externalTaskId = input.external_task_id || input.task_id;

      // 先试 stream-json：能拿到 thinking 块（与 text 分开）；失败/空则回退 text
      const streamed = await this._runStreamingCli([...sessionArgs, '-p', '-o', 'stream-json'], fullPrompt, timeoutMs, model, onChunk, externalTaskId, onReasoning);
      if (!this._capturedSessionId && streamed) {
        this._capturedSessionId = this._extractSessionId(streamed.text || '');
      }

      if (streamed && streamed.cancelled) {
        ModelLogger.logResponse(this.name, model, '[用户停止]', {
          ...meta, request_id: requestId, status: 'cancelled', error_code: 'CANCELLED',
          error_message: '用户已停止本轮任务', duration_ms: Date.now() - startTime,
          exit_code: streamed.exit_code, killed_by_timeout: false, stream_ok: streamed.streamed_ok,
        });
        return buildOutput(input.task_id, 'cancelled', streamed.text || '', {
          error: { code: 'CANCELLED', message: '用户已停止本轮任务' },
          duration_ms: Date.now() - startTime,
          session_id: this._capturedSessionId || session.id || null,
        });
      }

      if (streamed && streamed.exit_code === 0 && streamed.streamed_ok && streamed.text) {
        ModelLogger.logResponse(this.name, model, streamed.text, {
          ...meta, request_id: requestId, status: 'success',
          duration_ms: Date.now() - startTime, exit_code: streamed.exit_code,
          killed_by_timeout: false, stream_ok: true,
        });
        return buildOutput(input.task_id, 'success', streamed.text, {
          tokens_used: this._estimateTokens(streamed.text),
          duration_ms: Date.now() - startTime,
          session_id: this._capturedSessionId || session.id || null,
          reasoning: this._capturedReasoning,
        });
      }

      // 回退 text 模式
      const result = await this._runCli([...sessionArgs, '-p', '-o', 'text'], fullPrompt, timeoutMs, model, onChunk, externalTaskId);
      if (!this._capturedSessionId) {
        this._capturedSessionId = this._extractSessionId(result.stdout);
      }

      // 用户主动停止本轮：返回 cancelled（不当作失败/超时，避免上层重试链）
      if (result.cancelled) {
        ModelLogger.logResponse(this.name, model, '[用户停止]', {
          ...meta, request_id: requestId, status: 'cancelled', error_code: 'CANCELLED',
          error_message: '用户已停止本轮任务', duration_ms: Date.now() - startTime,
          exit_code: result.exit_code, killed_by_timeout: false, stream_ok: null,
        });
        return buildOutput(input.task_id, 'cancelled', result.stdout || '', {
          error: { code: 'CANCELLED', message: '用户已停止本轮任务' },
          duration_ms: Date.now() - startTime,
          session_id: this._capturedSessionId || session.id || null,
        });
      }

      if (result.exit_code === 0) {
        ModelLogger.logResponse(this.name, model, result.stdout, {
          ...meta, request_id: requestId, status: 'success',
          duration_ms: Date.now() - startTime, exit_code: result.exit_code,
          killed_by_timeout: false, stream_ok: null,
        });
        return buildOutput(input.task_id, 'success', result.stdout, {
          tokens_used: this._estimateTokens(result.stdout),
          duration_ms: Date.now() - startTime,
          session_id: this._capturedSessionId || session.id || null,
        });
      } else {
        let errMsg;
        let errorCode = 'CLI_ERROR';
        if (result.killed_by_timeout) {
          errorCode = 'TIMEOUT';
          const errTail = result.stderr ? `；stderr: ${String(result.stderr).slice(0, 300)}` : '';
          errMsg = `模型调用超时（超过 ${Math.round(timeoutMs / 1000)} 秒无结果，进程已被中断${errTail}）`;
        } else {
          errMsg = result.stderr || result.stdout || 'Unknown error';
          if (errMsg.includes('Not logged in') || errMsg.includes('login')) {
            errorCode = 'AUTH_REQUIRED';
          } else if (SESSION_MISSING_PATTERNS.some(re => re.test(errMsg))) {
            errorCode = ERROR_CODE.SESSION_NOT_FOUND;
          } else if (errMsg.includes('timeout')) {
            errorCode = 'TIMEOUT';
          }
        }
        ModelLogger.logResponse(this.name, model, errMsg, {
          ...meta, request_id: requestId, status: 'failed', error_code: errorCode,
          error_message: String(errMsg).substring(0, 500), duration_ms: Date.now() - startTime,
          exit_code: result.exit_code, killed_by_timeout: result.killed_by_timeout,
          stream_ok: null,
        });
        return buildOutput(input.task_id, 'failed', result.stdout || '', {
          error: { code: errorCode, message: errMsg.substring(0, 500) },
          duration_ms: Date.now() - startTime,
          session_id: this._capturedSessionId || session.id || null,
        });
      }
    } catch (e) {
      ModelLogger.logResponse(this.name, model, e.message, {
        ...meta, request_id: requestId, status: 'failed', error_code: 'EXECUTION_ERROR',
        error_message: String(e.message).substring(0, 500), duration_ms: Date.now() - startTime,
        exit_code: null, killed_by_timeout: false, stream_ok: null,
      });
      return buildOutput(input.task_id, 'failed', '', {
        error: { code: 'EXECUTION_ERROR', message: e.message },
        duration_ms: Date.now() - startTime,
        session_id: this._capturedSessionId || session.id || null,
      });
    }
  }

  /** 从 CLI 输出中尽力提取 session_id */
  _extractSessionId(text) {
    if (!text) return null;
    const s = String(text);
    let m = s.match(/"session_id"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
    m = s.match(/"sessionId"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  }

  /**
   * 执行 CLI（stream-json 模式）：逐行解析 NDJSON，
   * 把 thinking 块累积到 this._capturedReasoning，text 块推给 onChunk。
   * qwen/deepseek 的 stream-json 是分阶段缓冲（thinking 一整块 → text 一整块），
   * 但至少能把思考与正文分开，且能拿到思考全文。
   */
  _runStreamingCli(args, prompt, timeoutMs, modelOverride, onChunk, taskId, onReasoning) {
    return new Promise((resolve) => {
      const startAt = Date.now();
      let stderr = '';
      let buf = '';
      let streamedText = '';
      let parsedAny = false;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const emit = (text) => {
        streamedText += text;
        if (typeof onChunk === 'function') {
          try { onChunk(text); } catch (e) { /* 回调异常不影响主流程 */ }
        }
      };

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let json;
        try { json = JSON.parse(trimmed); } catch (e) { return; }
        parsedAny = true;

        if (json.session_id && !this._capturedSessionId) {
          this._capturedSessionId = json.session_id;
        }

        // 从 content[] 里提取指定类型块
        const extract = (msg, kind) => {
          if (!msg) return '';
          const content = msg.content;
          if (typeof content === 'string') return kind === 'text' ? content : '';
          if (Array.isArray(content)) {
            return content
              .filter(b => b && b.type === kind)
              .map(b => (kind === 'thinking' ? b.thinking : b.text))
              .filter(t => typeof t === 'string')
              .join('');
          }
          return '';
        };

        if (json.type === 'assistant' && json.message) {
          const thinking = extract(json.message, 'thinking');
          if (thinking && !this._reasoningSet.has(thinking)) {
            this._reasoningSet.add(thinking);
            this._capturedReasoning = this._capturedReasoning ? this._capturedReasoning + '\n\n' + thinking : thinking;
            // 思考块到达时立即回传（先于答案正文输出）
            if (typeof onReasoning === 'function') {
              try { onReasoning(thinking); } catch (e) { /* 回调异常不影响主流程 */ }
            }
          }
          const text = extract(json.message, 'text');
          if (text) emit(text);
        } else if (json.type === 'result' && typeof json.result === 'string') {
          // assistant 未给出完整文本时，用 result 补齐
          if (json.result.length > streamedText.length) {
            emit(json.result.slice(streamedText.length));
          }
        }
      };

      // prompt 通过 stdin 传入（qwen-code 0.22 的 stream-json 模式读 stdin，位置参数被忽略）
      const finalArgs = [];
      for (let i = 0; i < args.length; i++) {
        finalArgs.push(args[i]);
      }
      const model = modelOverride || this._getModel();
      if (model && model !== 'qwen-default') finalArgs.push('-m', model);

      const apiKey = this._getApiKey();
      const baseUrl = this._getBaseUrl();
      const envVars = { ...process.env, HOME: this.realHome };
      if (apiKey) envVars.OPENAI_API_KEY = apiKey;
      if (baseUrl) envVars.OPENAI_BASE_URL = baseUrl;

      const proc = spawn(this.cliCommand, finalArgs, {
        cwd: ROOT,
        env: envVars,
        timeout: timeoutMs || 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      procRegistry.register(proc, taskId);
      if (prompt) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }

      proc.stdout.on('data', (data) => {
        buf += data.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      });

      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (buf.trim()) handleLine(buf);
        const userKilled = procRegistry.isUserKilled(proc);
        finish({
          exit_code: code,
          text: streamedText,
          stderr: stderr.trim(),
          streamed_ok: parsedAny,
          killed_by_timeout: !userKilled && (code === null || Date.now() - startAt >= (timeoutMs || 120000) - 500),
          cancelled: userKilled,
        });
      });

      proc.on('error', (err) => {
        finish({
          exit_code: -1,
          text: streamedText,
          stderr: err.message,
          streamed_ok: parsedAny,
          killed_by_timeout: false,
          cancelled: false,
        });
      });
    });
  }

  _buildPrompt(input) {
    return buildPrompt({
      agentName: input.agent_name || '钱文',
      modelCli: 'qwen',
      role: input.role,
      taskId: input.task_id,
      context: input.context,
      instruction: input.instruction,
    });
  }

  _runCli(args, prompt, timeoutMs, modelOverride, onChunk, taskId) {
    return new Promise((resolve) => {
      const startAt = Date.now();
      let stdout = '';
      let stderr = '';
      let streamedLen = 0;

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
      procRegistry.register(proc, taskId);

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
        const userKilled = procRegistry.isUserKilled(proc);
        resolve({
          exit_code: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          // code === null 表示被信号杀死；用户主动停止不算超时
          killed_by_timeout: !userKilled && (code === null || Date.now() - startAt >= (timeoutMs || 120000) - 500),
          cancelled: userKilled,
        });
      });

      proc.on('error', (err) => {
        resolve({
          exit_code: -1,
          stdout: stdout.trim(),
          stderr: err.message,
          killed_by_timeout: false,
          cancelled: false,
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

module.exports = { QwenAdapter };
