const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ModelLogger = require('../utils/model-logger');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * 统一输入格式验证
 */
function validateKimiInput(input) {
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
function buildKimiOutput(taskId, status, content, opts = {}) {
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
 * 检测真实用户 HOME 目录
 */
function detectRealHome() {
  if (process.env.HOST_HOME && fs.existsSync(process.env.HOST_HOME)) {
    return process.env.HOST_HOME;
  }
  const usersDir = '/Users';
  if (fs.existsSync(usersDir)) {
    const users = fs.readdirSync(usersDir).filter(u => !u.startsWith('.') && u !== 'Shared');
    for (const user of users) {
      const candidate = path.join(usersDir, user);
      if (fs.existsSync(path.join(candidate, '.kimi'))) {
        return candidate;
      }
    }
  }
  return os.homedir();
}

/**
 * 吉米 (Kimi Code CLI) 适配器
 *
 * 调用方式：
 *   kimi -p "prompt" --output-format stream-json --yolo --model <model>
 *
 * 参数说明：
 *   -p, --prompt              非交互模式，直接执行提示词
 *   --output-format stream-json  流式 JSON 输出（便于解析）
 *   --yolo                    自动批准操作（适合自动化场景）
 *   --model <model>           指定模型
 *   --add-dir <path>          允许 Kimi 访问指定目录
 */
class KimiAdapter {
  constructor() {
    this.name = 'KimiAdapter';
    // 自动发现 Kimi Code CLI 安装路径
    // 优先检查 npm global 安装路径，然后回退到 PATH 中的 kimi
    this.cliCommand = this._findCliPath() || 'kimi';
    this.realHome = detectRealHome();
    this._config = null;
  }

  /**
   * 自动发现 kimi CLI 的完整路径
   * 优先级: npm global bin > /usr/local/bin/kimi > PATH中的 kimi
   */
  _findCliPath() {
    const candidates = [];
    const home = detectRealHome();

    // npm global 安装路径（本地沙箱环境）
    if (process.env.HOME) {
      // 沙箱环境 npm global
      candidates.push(path.join(process.env.HOME, '.npm-global', 'bin', 'kimi'));
    }
    // /usr/local/bin
    candidates.push('/usr/local/bin/kimi');
    // 宿主机 Homebrew 路径
    candidates.push(path.join(home, '.npm-global', 'bin', 'kimi'));
    // 系统默认
    candidates.push('/opt/homebrew/bin/kimi');

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    // 回退：假设 PATH 中有
    return null;
  }

  _getConfig() {
    if (!this._config) {
      this._config = require('../utils/config');
    }
    return this._config;
  }

  /**
   * 获取 KIMI_API_KEY
   * 优先级：环境变量 > config/api_keys.yaml > Kimi Code 原生认证 (~/.kimi/)
   */
  _getApiKey() {
    if (process.env.KIMI_API_KEY) {
      return process.env.KIMI_API_KEY;
    }
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.kimi_api_key) {
      return cfg.apiKeys.kimi_api_key;
    }
    return null;
  }

  /**
   * 获取 KIMI_BASE_URL（自定义供应商地址）
   */
  _getBaseUrl() {
    if (process.env.KIMI_BASE_URL) {
      return process.env.KIMI_BASE_URL;
    }
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.kimi_base_url) {
      return cfg.apiKeys.kimi_base_url;
    }
    return null;
  }

  /**
   * 获取模型名称
   */
  _getModel() {
    if (process.env.KIMI_MODEL) {
      return process.env.KIMI_MODEL;
    }
    const cfg = this._getConfig();
    if (cfg.apiKeys && cfg.apiKeys.kimi_model) {
      return cfg.apiKeys.kimi_model;
    }
    // 不指定则使用 Kimi Code 默认模型
    return null;
  }

  getName() {
    return this.name;
  }

  /**
   * 健康检查：调用 kimi --version 确认 CLI 可用
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
   * @returns {Promise<Object>} UnifiedOutput
   */
  async execute(input) {
    validateKimiInput(input);
    const startTime = Date.now();

    const prompt = this._buildPrompt(input);

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
    const model = this._getModel() || process.env.KIMI_MODEL || 'kimi-default';
    ModelLogger.logRequest(this.name, model, fullPrompt);

    // 构建 CLI 参数（--output-format 需要 = 符号连接值）
    const args = [
      '-p',
      '--output-format=text',
      '--add-dir', ROOT,
    ];

    if (model !== 'kimi-default') {
      args.push('-m', model);
    }

    const promptLength = fullPrompt.length;
    const timeoutMs = Math.max(60000, promptLength * 2 + 30000);

    try {
      const result = await this._runCli(args, fullPrompt, timeoutMs);

      if (result.exit_code === 0) {
        // 使用 text 格式，stdout 直接就是内容；仍然尝试 stream-json 解析以兼容
        const content = result.stdout ? this._parseStreamJson(result.stdout) : '';
        ModelLogger.logResponse(this.name, model, content);
        return buildKimiOutput(input.task_id, 'success', content, {
          tokens_used: this._estimateTokens(content),
          duration_ms: Date.now() - startTime,
        });
      } else {
        const errMsg = result.stderr || result.stdout || 'Unknown error';
        ModelLogger.logResponse(this.name, model, errMsg);
        let errorCode = 'CLI_ERROR';
        if (errMsg.includes('Not logged in') || errMsg.includes('login')) {
          errorCode = 'AUTH_REQUIRED';
        } else if (errMsg.includes('timeout')) {
          errorCode = 'TIMEOUT';
        }
        return buildKimiOutput(input.task_id, 'failed', result.stdout || '', {
          error: { code: errorCode, message: errMsg.substring(0, 500) },
          duration_ms: Date.now() - startTime,
        });
      }
    } catch (e) {
      ModelLogger.logResponse(this.name, model, e.message);
      return buildKimiOutput(input.task_id, 'failed', '', {
        error: { code: 'EXECUTION_ERROR', message: e.message },
        duration_ms: Date.now() - startTime,
      });
    }
  }

  /**
   * 构建提示词
   */
  _buildPrompt(input) {
    const roleLabel = {
      'executor': '执行者',
      'reviewer': '评审者',
      'guardian': '愿景守护者',
    }[input.role] || input.role;

    const lines = [
      `你是一个多智能体协作平台中的${roleLabel}智能体（吉米）。`,
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
   * 解析 stream-json 输出
   * Kimi Code 的 --output-format stream-json 输出每行一个 JSON 事件，
   * 我们提取 type === 'assistant' 且 message.content 为文本的事件，拼接为最终内容。
   */
  _parseStreamJson(stdout) {
    if (!stdout) return '';
    // 如果不是 JSON 流（纯文本输出），直接返回
    const trimmed = stdout.trim();
    if (!trimmed.startsWith('{')) return trimmed;
    const lines = trimmed.split('\n').filter(l => l.trim());
    const textParts = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        // 提取助手消息中的文本内容
        if (event.type === 'assistant' && event.message && event.message.content) {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                textParts.push(block.text);
              }
            }
          } else if (typeof content === 'string') {
            textParts.push(content);
          }
        }
        // 某些版本使用 result 字段
        if (event.type === 'result' && event.result) {
          textParts.push(event.result);
        }
      } catch (e) {
        // 非 JSON 行，保留原始文本（兼容纯文本输出）
        textParts.push(line);
      }
    }

    return textParts.join('\n').trim();
  }

  /**
   * 执行 CLI 命令
   */
  _runCli(args, prompt, timeoutMs) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const finalArgs = [];
      for (let i = 0; i < args.length; i++) {
        finalArgs.push(args[i]);
        if (args[i] === '-p' && prompt) {
          finalArgs.push(prompt);
        }
      }

      const apiKey = this._getApiKey();
      const baseUrl = this._getBaseUrl();
      const env = { ...process.env, HOME: this.realHome };
      if (apiKey) {
        env.KIMI_API_KEY = apiKey;
      }
      if (baseUrl) {
        env.KIMI_BASE_URL = baseUrl;
      }

      const proc = spawn(this.cliCommand, finalArgs, {
        cwd: ROOT,
        env: { ...env, PATH: [path.dirname(this.cliCommand), env.PATH || process.env.PATH].join(':') },
        timeout: timeoutMs || 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          exit_code: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });

      proc.on('error', (err) => {
        resolve({
          exit_code: -1,
          stdout: stdout.trim(),
          stderr: err.message,
        });
      });
    });
  }

  /**
   * 粗略估算 token 数量
   */
  _estimateTokens(text) {
    if (!text) return 0;
    const chineseChars = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars + otherChars / 3);
  }
}

module.exports = { KimiAdapter, validateKimiInput, buildKimiOutput };
