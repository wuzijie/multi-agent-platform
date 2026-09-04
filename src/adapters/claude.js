const { spawn } = require('child_process');
const procRegistry = require('../utils/proc-registry');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ModelLogger = require('../utils/model-logger');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * 统一输入格式验证
 */
function validateUnifiedInput(input) {
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

/**
 * 统一输出格式构建
 */
function buildUnifiedOutput(taskId, status, content, opts = {}) {
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

/**
 * 检测真实用户 HOME 目录（宿主机）
 * 在 sandbox 环境中 HOME 可能指向沙箱临时目录，
 * 真正的用户凭证在宿主机的 ~/.claude/ 下
 */
function detectRealHome() {
  // 1. 优先使用环境变量
  if (process.env.HOST_HOME && fs.existsSync(process.env.HOST_HOME)) {
    return process.env.HOST_HOME;
  }
  // 2. 如果是 macOS，检查 /Users 下的真实用户
  const hostname = os.hostname();
  const usersDir = '/Users';
  if (fs.existsSync(usersDir)) {
    const users = fs.readdirSync(usersDir).filter(u => !u.startsWith('.') && u !== 'Shared');
    for (const user of users) {
      const candidate = path.join(usersDir, user);
      if (fs.existsSync(path.join(candidate, '.claude.json'))) {
        return candidate;
      }
    }
  }
  // 3. 回退到 $HOME
  return os.homedir();
}

/**
 * 克劳德 (Claude Code CLI) 适配器
 *
 * 调用方式：
 *   claude --print --output-format text [--permission-mode bypassPermissions] "prompt"
 *
 * 参数说明：
 *   --print                   非交互模式，仅输出结果
 *   --output-format text      纯文本输出（默认值，显式指定）
 *   --output-format json      单次 JSON 输出
 *   --output-format stream-json 流式 JSON 输出
 *   --permission-mode bypassPermissions  跳过权限确认（适合自动化场景）
 *   --add-dir <path>          允许 Claude 访问指定目录
 *   --max-budget-usd <amount> API 调用费用上限
 *
 * prompt 通过命令行参数直接传入（非 stdin），避免 stdin 超时警告。
 */
class ClaudeAdapter {
  constructor() {
    this.name = 'ClaudeAdapter';
    this.cliCommand = 'claude';
    this.realHome = detectRealHome();
    // 延迟加载 config（避免循环依赖时序问题）
    this._config = null;
  }

  /**
   * 获取配置（延迟加载）
   */
  _getConfig() {
    if (!this._config) {
      this._config = require('../utils/config');
    }
    // 每次调用都重新加载配置（防止运行中改了 api_keys.yaml 但进程缓存旧值）
    try { this._config.loadAll(); } catch (e) { /* 忽略重复加载错误 */ }
    return this._config;
  }

  /**
   * 获取 ANTHROPIC_API_KEY
   * 优先级：环境变量 > config/api_keys.yaml（deepseek_api_key / anthropic_api_key）> 宿主机 ~/.claude/ 认证
   */
  _getApiKey() {
    // 1. 环境变量（直接设置时优先）
    if (process.env.ANTHROPIC_API_KEY) {
      return process.env.ANTHROPIC_API_KEY;
    }
    // 2. 本地配置文件：优先使用 deepseek_api_key，否则用 anthropic_api_key
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.deepseek_api_key) {
      return cfg.apiKeys.deepseek_api_key;
    }
    if (cfg.apiKeys && cfg.apiKeys.anthropic_api_key) {
      return cfg.apiKeys.anthropic_api_key;
    }
    // 3. 不返回 null（让 CLI 自己查找 cc-switch 配置或原生认证）
    return null;
  }

  /**
   * 获取 ANTHROPIC_BASE_URL（模型供应商地址）
   * 优先级：环境变量 > config/api_keys.yaml
   */
  _getBaseUrl() {
    if (process.env.ANTHROPIC_BASE_URL) {
      return process.env.ANTHROPIC_BASE_URL;
    }
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.anthropic_base_url) {
      return cfg.apiKeys.anthropic_base_url;
    }
    return null;
  }

  /**
   * 获取模型覆盖名称
   * 优先级：环境变量 > config/api_keys.yaml
   */
  _getModelOverride() {
    // Claude Code 使用 ANTHROPIC_DEFAULT_OPUS_MODEL 等环境变量，
    // 但对非 Anthropic 供应商通常需要在 base URL 层面做模型映射。
    // 这里使用 ANTHROPIC_MODEL 作为通用覆盖（部分代理/网关支持该字段）
    if (process.env.ANTHROPIC_MODEL) {
      return process.env.ANTHROPIC_MODEL;
    }
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.model_override) {
      return cfg.apiKeys.model_override;
    }
    return null;
  }

  getName() {
    return this.name;
  }

  /**
   * 健康检查：调用 claude --version 确认 CLI 可用
   */
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

  /**
   * 执行任务
   *
   * @param {Object} input - UnifiedInput
   * @param {Function} [onChunk] 流式回调：捕获到 CLI 增量输出时调用 onChunk(增量文本)
   * @returns {Promise<Object>} UnifiedOutput
   */
  async execute(input, onChunk) {
    validateUnifiedInput(input);
    const startTime = Date.now();

    // 构建提示词
    const prompt = this._buildPrompt(input);

    // 如果有输入文件，将内容附加到 prompt
    let fullPrompt = prompt;
    if (input.input_files && input.input_files.length > 0) {
      const fileContents = input.input_files.map(f => {
        const filePath = path.isAbsolute(f) ? f : path.join(ROOT, f);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          return `\n\n=== 文件: ${f} ===\n${content}`;
        }
        return `\n\n=== 文件 ${f} 不存在 ===`;
      }).join('\n');
      fullPrompt += fileContents;
    }

    // 获取当前使用的模型名称
    const model = this._getModelOverride() || process.env.ANTHROPIC_MODEL || 'claude-default';
    // 请求链路追踪元信息（用于把 request/response 关联成对，并按任务回溯）
    const meta = {
      task_id: input.task_id || '',
      trace_id: input.trace_id || '',
      external_task_id: input.external_task_id || '',
      agent_name: input.agent_name || '',
      phase: input.phase || 'initial',
      attempt: input.attempt || 1,
    };
    const requestId = ModelLogger.logRequest(this.name, model, fullPrompt, meta);

    // 构建 CLI 参数
    // 注意：text 格式的输出是非流式的（结束才一次性吐出），
    // 因此优先使用 stream-json（需配合 --verbose）实现真流式。
    const baseArgs = [
      '--print',
      '--permission-mode', 'bypassPermissions',
      '--add-dir', ROOT,
      '--bare',
    ];
    const streamArgs = [...baseArgs, '--output-format', 'stream-json', '--verbose'];
    const textArgs = [...baseArgs, '--output-format', 'text'];

    // 超时计算
    // 下限 240 秒：克劳德 CLI 启动本身约需 10-20 秒，慢模型（如 DeepSeek 后端）完成长任务
    // 常超过 60 秒。调度器对子任务的预算为 300 秒，适配器必须在此之内自行返回，
    // 因此取 240 秒下限（留出事件处理余量），避免进程被 spawn timeout 提前杀死。
    const promptLength = fullPrompt.length;
    const timeoutMs = Math.max(240000, promptLength * 2 + 30000);

    try {
      // 先尝试流式模式
      const streamed = await this._runStreamingCli(streamArgs, fullPrompt, timeoutMs, onChunk, input.external_task_id || input.task_id);

      if (streamed.exit_code === 0 && streamed.streamed_ok && streamed.text) {
        ModelLogger.logResponse(this.name, model, streamed.text, {
          ...meta, request_id: requestId, status: 'success',
          duration_ms: Date.now() - startTime, exit_code: streamed.exit_code,
          killed_by_timeout: false, stream_ok: true,
        });
        return buildUnifiedOutput(input.task_id, 'success', streamed.text, {
          tokens_used: this._estimateTokens(streamed.text),
          duration_ms: Date.now() - startTime,
        });
      }

      if (streamed.exit_code === 0 && streamed.streamed_ok && !streamed.text) {
        ModelLogger.logResponse(this.name, model, '(空响应)', {
          ...meta, request_id: requestId, status: 'failed', error_code: 'EMPTY_RESPONSE',
          error_message: '模型返回空内容', duration_ms: Date.now() - startTime,
          exit_code: streamed.exit_code, killed_by_timeout: false, stream_ok: true,
        });
        return buildUnifiedOutput(input.task_id, 'failed', '', {
          error: { code: 'EMPTY_RESPONSE', message: '模型返回空内容' },
          duration_ms: Date.now() - startTime,
        });
      }

      if (streamed.exit_code !== 0) {
        // 流式模式整体失败（如认证错误/超时被杀）：直接按失败处理，不再回退
        let errMsg;
        let errorCode = 'CLI_ERROR';
        if (streamed.killed_by_timeout) {
          errorCode = 'TIMEOUT';
          errMsg = `模型调用超时（超过 ${Math.round(timeoutMs / 1000)} 秒无结果，进程已被中断）`;
        } else {
          errMsg = streamed.stderr || streamed.text || 'Unknown error';
          if (errMsg.includes('Not logged in')) {
            errorCode = 'AUTH_REQUIRED';
          } else if (errMsg.includes('timeout')) {
            errorCode = 'TIMEOUT';
          }
        }
        ModelLogger.logResponse(this.name, model, errMsg, {
          ...meta, request_id: requestId, status: 'failed', error_code: errorCode,
          error_message: String(errMsg).substring(0, 500), duration_ms: Date.now() - startTime,
          exit_code: streamed.exit_code, killed_by_timeout: streamed.killed_by_timeout,
          stream_ok: streamed.streamed_ok,
        });
        return buildUnifiedOutput(input.task_id, 'failed', streamed.text || '', {
          error: { code: errorCode, message: errMsg.substring(0, 500) },
          duration_ms: Date.now() - startTime,
        });
      }

      // stream-json 成功退出但没有解析到事件（旧版 CLI 等）→ 回退 text 模式
      // 注意：streamed.text 为空，因此不会有已推送的增量需要去重
      ModelLogger.logResponse(this.name, model, '[stream-json 无事件输出，回退 text 模式]', {
        ...meta, request_id: requestId, status: 'success',
        duration_ms: Date.now() - startTime, exit_code: streamed.exit_code,
        killed_by_timeout: false, stream_ok: false,
      });
      const result = await this._runCli(textArgs, fullPrompt, timeoutMs, onChunk, input.external_task_id || input.task_id);

      if (result.exit_code === 0) {
        ModelLogger.logResponse(this.name, model, result.stdout, {
          ...meta, request_id: requestId, status: 'success',
          duration_ms: Date.now() - startTime, exit_code: result.exit_code,
          killed_by_timeout: false, stream_ok: null,
        });
        return buildUnifiedOutput(input.task_id, 'success', result.stdout, {
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
          if (errMsg.includes('Not logged in')) {
            errorCode = 'AUTH_REQUIRED';
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
        return buildUnifiedOutput(input.task_id, 'failed', result.stdout || '', {
          error: { code: errorCode, message: errMsg.substring(0, 500) },
          duration_ms: Date.now() - startTime,
        });
      }
    } catch (e) {
      ModelLogger.logResponse(this.name, model, e.message, {
        ...meta, request_id: requestId, status: 'failed', error_code: 'EXECUTION_ERROR',
        error_message: String(e.message).substring(0, 500), duration_ms: Date.now() - startTime,
        exit_code: null, killed_by_timeout: false, stream_ok: null,
      });
      return buildUnifiedOutput(input.task_id, 'failed', '', {
        error: { code: 'EXECUTION_ERROR', message: e.message },
        duration_ms: Date.now() - startTime,
      });
    }
  }

  /**
   * 构建发送给 Claude Code CLI 的提示词
   */
  _buildPrompt(input) {
    const roleLabel = {
      'executor': '执行者',
      'reviewer': '评审者',
      'guardian': '愿景守护者',
    }[input.role] || input.role;

    const lines = [
      `你是一个多智能体协作平台中的${roleLabel}智能体。`,
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

  /**
   * 构建 CLI 环境变量：注入 API Key 和供应商地址（如果有配置的话）
   */
  _buildEnv() {
    const apiKey = this._getApiKey();
    const baseUrl = this._getBaseUrl();
    const modelOverride = this._getModelOverride();
    const env = { ...process.env, HOME: this.realHome };
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }
    if (baseUrl) {
      env.ANTHROPIC_BASE_URL = baseUrl;
    }
    if (modelOverride) {
      env.ANTHROPIC_MODEL = modelOverride;
    }
    // 同步 ~/.claude/ 下的 API key 到 config 一致（静默，不打印）
    this._syncSettingsKey(apiKey, baseUrl);
    return env;
  }

  /**
   * 同步 ~/.claude/ 下所有可能存 key 的文件到 config 一致（静默）
   */
  _syncSettingsKey(apiKey) {
    if (!apiKey) return;
    const home = this.realHome;
    // 检查所有可能的配置文件
    const candidates = [
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.claude.json'),
      path.join(home, '.claude', 'config.json'),
    ];
    for (const settingsPath of candidates) {
      try {
        if (!fs.existsSync(settingsPath)) continue;
        const raw = fs.readFileSync(settingsPath, 'utf8');
        if (!raw.trim()) continue;
        const settings = JSON.parse(raw);
        let changed = false;
        // 递归查找并替换所有 sk- 开头的旧 key
        const replaceKey = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === 'string' && v.startsWith('sk-') && v !== apiKey && v.length > 20) {
              obj[k] = apiKey;
              changed = true;
            } else if (typeof v === 'object') {
              replaceKey(v);
            }
          }
        };
        replaceKey(settings);
        if (changed) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        }
      } catch (e) {
        // 静默失败：settings.json 读取/写入失败不影响主流程（env var 仍传了新 key）
      }
    }
  }

  /**
   * 执行 CLI 命令
   *
   * Claude Code CLI 的参数传递方式：
   * - 短 prompt（< 几千字节）：直接作为最后一个位置参数
   * - prompt 中的特殊字符（引号、换行等）由 spawn 自动处理
   *
   * --bare 模式说明：
   * - 跳过 hooks, LSP, plugins, auto-memory, CLAUDE.md 发现
   * - 减少启动延迟，适合编程式调用
   */
  _runCli(args, prompt, timeoutMs, onChunk, taskId) {
    return new Promise((resolve) => {
      const startAt = Date.now();
      let stdout = '';
      let stderr = '';
      // 已推送给 onChunk 的输出长度（增量计算用）
      let streamedLen = 0;

      // prompt 作为最后一个位置参数传入
      const finalArgs = prompt ? [...args, prompt] : args;

      const env = this._buildEnv();

      const proc = spawn(this.cliCommand, finalArgs, {
        cwd: ROOT,
        env,
        timeout: timeoutMs || 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      procRegistry.register(proc, taskId);

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        // 流式回调：把增量文本推送给上层（编排器→事件总线→前端）
        if (typeof onChunk === 'function') {
          const added = stdout.length - streamedLen;
          if (added > 0) {
            streamedLen = stdout.length;
            onChunk(stdout.substring(streamedLen - added));
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

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

  /**
   * 执行 CLI 命令（stream-json 流式模式）
   *
   * Claude Code 的 --output-format text 是非流式的（输出结束时一次性吐出），
   * 而 stream-json 会逐行输出 JSON 事件，可以在生成过程中拿到增量文本。
   * 注意：stream-json 必须配合 --verbose 使用。
   *
   * 解析的事件：
   *  - {"type":"stream_event","event":{"type":"content_block_delta",
   *     "delta":{"type":"text_delta","text":"..."}}}  → 增量文本（真流式）
   *  - {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
   *     → 补齐尚未推送的尾部文本（去重）
   *
   * 返回 { exit_code, text, stderr, streamed_ok }：
   *  - text：从事件中提取的完整回答文本
   *  - streamed_ok：是否成功解析到 JSON 事件（false 时调用方应回退 text 模式）
   */
  _runStreamingCli(args, prompt, timeoutMs, onChunk, taskId) {
    return new Promise((resolve) => {
      const startAt = Date.now();
      let stderr = '';
      let buf = '';
      let streamedText = '';
      let emittedLen = 0;
      let parsedAny = false;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const killedByTimeout = () =>
        Date.now() - startAt >= (timeoutMs || 120000) - 500;

      const emit = (text) => {
        streamedText += text;
        if (typeof onChunk === 'function') {
          try {
            onChunk(text);
          } catch (e) { /* 回调异常不影响主流程 */ }
        }
        emittedLen += text.length;
      };

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let json;
        try {
          json = JSON.parse(trimmed);
        } catch (e) {
          return; // 非 JSON 行（警告、进度等），忽略
        }
        parsedAny = true;

        // 从嵌套对象中安全提取文本内容块
        const extractText = (msg) => {
          if (!msg) return '';
          const content = msg.content;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            return content
              .filter(b => b && b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text)
              .join('');
          }
          return '';
        };

        if (json.type === 'stream_event' && json.event) {
          const ev = json.event;
          if (
            ev.type === 'content_block_delta' &&
            ev.delta &&
            (ev.delta.type === 'text_delta' || typeof ev.delta.text === 'string') &&
            ev.delta.text
          ) {
            emit(ev.delta.text);
          }
        } else if (json.type === 'assistant' && json.message) {
          // 标准 Claude Code stream-json 汇总事件：补齐尚未推送的尾部文本（去重）
          const fullText = extractText(json.message);
          if (fullText.length > emittedLen) {
            emit(fullText.slice(emittedLen));
          }
        } else if (json.type === 'result' && json.message) {
          // 部分版本/网关用 result 事件包裹最终消息
          const fullText = extractText(json.message);
          if (fullText.length > emittedLen) {
            emit(fullText.slice(emittedLen));
          }
        } else if (json.type === 'message' && json.content) {
          // 兼容直接输出 message 对象的情况
          const fullText = extractText(json);
          if (fullText.length > emittedLen) {
            emit(fullText.slice(emittedLen));
          }
        }
      };

      const finalArgs = prompt ? [...args, prompt] : args;
      const env = this._buildEnv();

      const proc = spawn(this.cliCommand, finalArgs, {
        cwd: ROOT,
        env,
        timeout: timeoutMs || 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      procRegistry.register(proc, taskId);

      proc.stdout.on('data', (data) => {
        buf += data.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (buf.trim()) handleLine(buf); // 最后一行可能没有换行符
        finish({
          exit_code: code,
          text: streamedText,
          stderr: stderr.trim(),
          streamed_ok: parsedAny,
          killed_by_timeout: code === null || killedByTimeout(),
        });
      });

      proc.on('error', (err) => {
        finish({
          exit_code: -1,
          text: streamedText,
          stderr: err.message,
          streamed_ok: parsedAny,
          killed_by_timeout: killedByTimeout(),
        });
      });
    });
  }

  /**
   * 粗略估算 token 数量
   * Claude 中文: ~1 token / 字符
   * Claude 英文: ~1 token / 4 字符
   * 这里用简单估算：中文 1 token/字，其他 1 token/3 字符
   */
  _estimateTokens(text) {
    if (!text) return 0;
    const chineseChars = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars + otherChars / 3);
  }
}

module.exports = { ClaudeAdapter };
