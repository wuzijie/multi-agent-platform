const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
   * @returns {Promise<Object>} UnifiedOutput
   */
  async execute(input) {
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

    // 构建 CLI 参数
    const args = [
      '--print',
      '--output-format', 'text',
      '--permission-mode', 'bypassPermissions',
      // 允许 Claude 访问项目根目录
      '--add-dir', ROOT,
      // 不加载 hooks / plugins，减少启动延迟
      '--bare',
    ];

    // 超时计算：prompt 越长，给更多时间
    const promptLength = fullPrompt.length;
    const timeoutMs = Math.max(60000, promptLength * 2 + 30000);

    try {
      const result = await this._runCli(args, fullPrompt, timeoutMs);

      if (result.exit_code === 0) {
        return buildUnifiedOutput(input.task_id, 'success', result.stdout, {
          tokens_used: this._estimateTokens(result.stdout),
          duration_ms: Date.now() - startTime,
        });
      } else {
        // 提取错误信息
        const errMsg = result.stderr || result.stdout || 'Unknown error';
        let errorCode = 'CLI_ERROR';
        if (errMsg.includes('Not logged in')) {
          errorCode = 'AUTH_REQUIRED';
        } else if (errMsg.includes('timeout')) {
          errorCode = 'TIMEOUT';
        }
        return buildUnifiedOutput(input.task_id, 'failed', result.stdout || '', {
          error: { code: errorCode, message: errMsg.substring(0, 500) },
          duration_ms: Date.now() - startTime,
        });
      }
    } catch (e) {
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
  _runCli(args, prompt, timeoutMs) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      // prompt 作为最后一个位置参数传入
      const finalArgs = prompt ? [...args, prompt] : args;

      // 构建环境变量：注入 API Key 和供应商地址（如果有配置的话）
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

      const proc = spawn(this.cliCommand, finalArgs, {
        cwd: ROOT,
        env,
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

module.exports = { ClaudeAdapter, validateUnifiedInput, buildUnifiedOutput };
