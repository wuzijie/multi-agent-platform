/**
 * OpenAI 兼容 chat/completions 流式客户端（SSE）
 *
 * 为什么需要这个模块：DeepSeekAdapter 与 QwenAdapter 复用的 qwen CLI
 * 会把输出缓冲到 API 调用结束后一次性吐出（-o text / -o stream-json 均如此），
 * 导致前端无法真正流式展示。该模块使用 Node 内置 https 模块直连
 * OpenAI 兼容的 /chat/completions 接口（stream: true），逐增量回调 onChunk，
 * 与现有 _streamedExecute / eventBus 流式管线无缝衔接。
 *
 * 无外部依赖：仅使用 https / http / url / zlib。
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');

/**
 * 调用 OpenAI 兼容 chat/completions 接口（流式）
 *
 * @param {object} opts
 * @param {string} opts.baseUrl   接口基地址，如 https://api.deepseek.com/v1
 * @param {string} opts.apiKey    认证密钥
 * @param {string} opts.model     模型名，如 deepseek-chat
 * @param {Array<{role:string, content:string}>} opts.messages 消息列表
 * @param {number} [opts.timeoutMs] 总超时（毫秒），默认 300000
 * @param {number} [opts.maxTokens] max_tokens，默认 8192
 * @param {number} [opts.temperature] 默认 0.7
 * @param {function(string):void} [opts.onChunk] 收到增量文本时回调
 * @returns {Promise<{ok:boolean, text:string, error?:string, statusCode?:number, duration_ms:number}>}
 */
function streamChatCompletion(opts) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    timeoutMs = 300000,
    maxTokens = 8192,
    temperature = 0.7,
    onChunk,
  } = opts;

  if (!baseUrl || !apiKey || !model) {
    return Promise.resolve({
      ok: false,
      text: '',
      error: 'streamChatCompletion: baseUrl / apiKey / model 均为必填项',
      duration_ms: 0,
    });
  }

  return new Promise((resolve) => {
    const start = Date.now();

    let urlStr;
    try {
      urlStr = new URL('/chat/completions', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toString();
    } catch (e) {
      resolve({ ok: false, text: '', error: `无效的 baseUrl: ${baseUrl}`, duration_ms: Date.now() - start });
      return;
    }

    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const isHttps = lib === https;

    const body = JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: false },
      max_tokens: maxTokens,
      temperature,
    });

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      const statusCode = res.statusCode || 0;

      if (statusCode < 200 || statusCode >= 300) {
        let errBody = '';
        res.on('data', (d) => { errBody += d.toString(); });
        res.on('end', () => {
          let msg = `HTTP ${statusCode}`;
          try {
            const j = JSON.parse(errBody);
            if (j.error && j.error.message) msg += `: ${j.error.message}`;
          } catch (e) { /* keep default */ }
          resolve({ ok: false, text: '', error: msg, statusCode, duration_ms: Date.now() - start });
        });
        return;
      }

      const isGzip = (res.headers['content-encoding'] || '').includes('gzip');
      let source = res;
      if (isGzip) {
        const gunzip = zlib.createGunzip();
        res.pipe(gunzip);
        source = gunzip;
      }

      let full = '';
      let buf = '';
      let streamedText = '';
      let sawData = false;

      const handleData = (d) => {
        sawData = true;
        buf += d.toString();

        // SSE 事件以空行分隔；同一网络块可能含多行
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);

          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let json;
          try {
            json = JSON.parse(payload);
          } catch (e) {
            continue; // 半截 JSON 或注释行，忽略
          }

          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          const piece = delta.content || '';
          if (piece) {
            streamedText += piece;
            if (typeof onChunk === 'function') {
              try { onChunk(piece); } catch (e) { /* 回调异常不影响主流程 */ }
            }
          }
        }
      };

      source.on('data', handleData);
      source.on('error', (e) => {
        resolve({ ok: false, text: streamedText, error: `SSE 读取错误: ${e.message}`, statusCode, duration_ms: Date.now() - start });
      });
      source.on('end', () => {
        if (!sawData) {
          resolve({ ok: false, text: '', error: '服务端未返回任何数据', statusCode, duration_ms: Date.now() - start });
          return;
        }
        resolve({ ok: true, text: streamedText, statusCode, duration_ms: Date.now() - start });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.on('error', (e) => {
      resolve({ ok: false, text: '', error: e.message, duration_ms: Date.now() - start });
    });

    req.end(body);
  });
}

module.exports = { streamChatCompletion };
