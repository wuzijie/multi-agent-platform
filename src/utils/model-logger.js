const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 日志根目录候选列表
 * 优先 /Volumes（Write 工具可达），回退项目根目录（VM 可达）
 */
function getLogRoots() {
  const candidates = [
    '/Volumes/data/we-work/multi-agent-platform',
    path.resolve(__dirname, '..', '..'),
  ];
  const roots = [];
  const seen = new Set();
  for (const root of candidates) {
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  // 兜底：至少保留 __dirname 推导的项目根
  if (roots.length === 0) {
    roots.push(path.resolve(__dirname, '..', '..'));
  }
  return roots;
}

const LOG_ROOTS = getLogRoots();

/**
 * 按小时生成日志文件名，如 2026-08-14_02.log
 * 每个文件记录该小时（00:00 - 59:59）内的所有请求和回复
 */
function hourFileName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' +
    pad(date.getMonth() + 1) + '-' +
    pad(date.getDate()) + '_' +
    pad(date.getHours()) + '.log'
  );
}

/**
 * 生成全局唯一请求 ID：req_<时间戳36进制>_<4字节随机hex>
 * 用于把 一次模型调用的 请求(request) 与 响应(response/error) 关联成对，
 * 并在多轮 tool round / 重试之间区分每一次独立的 CLI 调用。
 */
function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

/**
 * 模型 CLI 请求/响应日志记录器（请求全生命周期版）
 *
 * 日志位置：
 *   1) logs/agent/YYYY-MM-DD_HH.log       —— 按小时滚动的全量请求/响应流（跨任务）
 *   2) logs/requests/<task_id>.jsonl       —— 按任务聚合的单任务完整请求链路（便于异常回溯）
 *
 * 条目核心字段：
 * {
 *   "timestamp": "2026-08-12T10:30:00.123Z",
 *   "request_id": "req_xxx",              // 一次 CLI 调用的唯一 ID（请求/响应成对关联）
 *   "task_id": "task_xxx",                // 所属任务（异常回溯入口）
 *   "trace_id": "task_xxx",               // 事件驱动协作的 trace_id（DAG 编排唯一ID；非协作场景为空）
 *   "external_task_id": "conv_xxx",       // 对话级 task_id（UI/会话维度聚合；与 task_id 不同时为协作子任务）
 *   "agent_name": "克劳德",                // 业务侧 Agent 中文名
 *   "adapter": "ClaudeAdapter",           // 适配器类名
 *   "direction": "request" | "response",  // 请求 或 响应
 *   "model": "claude-sonnet-4-6",         // 实际模型
 *   "phase": "initial" | "tool_round_1",  // 调用阶段（初始 / 第 N 轮工具调用）
 *   "attempt": 1,                          // 第几次尝试
 *   "status": "success" | "failed",       // 响应侧：执行结果
 *   "error_code": "TIMEOUT",               // 响应侧：错误分类码
 *   "error_message": "...",                // 响应侧：错误详情（前500字符）
 *   "duration_ms": 12345,                  // 响应侧：本次调用耗时
 *   "exit_code": 0,                        // 响应侧：CLI 退出码
 *   "killed_by_timeout": false,            // 响应侧：是否被超时杀死
 *   "stream_ok": true,                     // 响应侧：流式解析是否成功
 *   "prompt_length": 1234,                 // 请求侧：入参长度
 *   "content_length": 5678,                // 响应侧：出参长度
 *   "content": "..."                       // 请求内容 / 响应内容
 * }
 *
 * 文件聚合规则（异常回溯三种入口）：
 *   1) logs/agent/YYYY-MM-DD_HH.log       —— 按小时全量流（跨任务）
 *   2) logs/requests/<task_id>.jsonl       —— 按任务聚合（task_id / sub_task_id / trace_id）
 *   3) logs/requests/<external_task_id>.jsonl —— 按对话聚合（协作子任务也会写入，方便从会话入口一次回溯全链路）
 */
class ModelLogger {
  /**
   * 写一条日志：同时写入按小时滚动文件（全部路径）与按任务聚合文件（首个可写路径）
   */
  /**
   * 追加到某个按任务聚合的 jsonl 文件（写第一个可写根目录，避免重复）
   * @param {string} fileKey 文件标识（task_id / external_task_id / trace_id）
   */
  static _appendToRequests(entry, fileKey) {
    if (!fileKey) return;
    const line = JSON.stringify(entry) + '\n';
    for (const root of LOG_ROOTS) {
      try {
        const reqDir = path.join(root, 'logs', 'requests');
        if (!fs.existsSync(reqDir)) {
          fs.mkdirSync(reqDir, { recursive: true });
        }
        fs.appendFileSync(path.join(reqDir, `${fileKey}.jsonl`), line);
        return; // 只写第一个可写路径
      } catch (e) {
        // 跳过不可写路径，尝试下一个
      }
    }
  }

  static _write(entry) {
    const line = JSON.stringify(entry) + '\n';
    const now = new Date();

    // 1) 按小时滚动文件（全部可写路径，历史行为保持一致）
    for (const root of LOG_ROOTS) {
      try {
        const logDir = path.join(root, 'logs', 'agent');
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        fs.appendFileSync(path.join(logDir, hourFileName(now)), line);
      } catch (e) {
        // 某些路径不可写（如 /Volumes 在 VM 中不可见），静默跳过
      }
    }

    // 2) 按任务聚合文件：task_id 文件 + 对话级 external_task_id 文件
    //    协作子任务 task_id=sub_task_id、external_task_id=对话ID，二者都写，
    //    保证从「对话」和「子任务」两个入口都能回溯到该次模型调用。
    if (entry.task_id) {
      this._appendToRequests(entry, entry.task_id);
    }
    if (entry.external_task_id && entry.external_task_id !== entry.task_id) {
      this._appendToRequests(entry, entry.external_task_id);
    }
  }

  /**
   * 记录一条请求（request）
   *
   * @param {string} adapterName 适配器名（如 ClaudeAdapter）
   * @param {string} model 模型名
   * @param {string} content 完整请求 prompt
   * @param {Object} [meta] 附加元信息
   * @param {string} [meta.request_id] 指定 request_id（缺省自动生成）
   * @param {string} [meta.task_id] 所属任务 ID（协作子任务时为 sub_task_id）
   * @param {string} [meta.trace_id] 事件驱动协作 trace_id（DAG 编排唯一ID）
   * @param {string} [meta.external_task_id] 对话级 task_id（UI/会话维度聚合）
   * @param {string} [meta.agent_name] Agent 中文名（克劳德/吉米/迪普斯克/钱文）
   * @param {string} [meta.phase] 调用阶段 initial / tool_round_N
   * @param {number} [meta.attempt] 第几次尝试
   * @returns {string} 本次调用的 request_id（用于后续 logResponse 关联）
   */
  static logRequest(adapterName, model, content, meta = {}) {
    const requestId = meta.request_id || genRequestId();
    const entry = {
      timestamp: new Date().toISOString(),
      request_id: requestId,
      task_id: meta.task_id || '',
      trace_id: meta.trace_id || '',
      external_task_id: meta.external_task_id || '',
      agent_name: meta.agent_name || '',
      adapter: adapterName,
      direction: 'request',
      model: model || 'default',
      phase: meta.phase || 'initial',
      attempt: meta.attempt || 1,
      prompt_length: content ? String(content).length : 0,
      content: content || '',
    };
    this._write(entry);
    return requestId;
  }

  /**
   * 记录一条响应（response / error）
   *
   * @param {string} adapterName 适配器名
   * @param {string} model 模型名
   * @param {string} content 响应内容（成功为输出文本，失败为错误信息）
   * @param {Object} [meta] 附加元信息（需含与请求一致的 request_id/task_id/trace_id/external_task_id/agent_name 等）
   */
  static logResponse(adapterName, model, content, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      request_id: meta.request_id || '',
      task_id: meta.task_id || '',
      trace_id: meta.trace_id || '',
      external_task_id: meta.external_task_id || '',
      agent_name: meta.agent_name || '',
      adapter: adapterName,
      direction: 'response',
      model: model || 'default',
      phase: meta.phase || 'initial',
      attempt: meta.attempt || 1,
      status: meta.status || (meta.error_code ? 'failed' : 'success'),
      error_code: meta.error_code || '',
      error_message: meta.error_message || '',
      duration_ms: meta.duration_ms || 0,
      exit_code: meta.exit_code === undefined ? null : meta.exit_code,
      killed_by_timeout: !!meta.killed_by_timeout,
      stream_ok: meta.stream_ok === undefined ? null : meta.stream_ok,
      content_length: content ? String(content).length : 0,
      content: content || '',
    };
    this._write(entry);
  }

  // ==================== 查询 / 诊断 ====================

  /**
   * 读取某个根目录下所有小时文件中的条目（内部）
   */
  static _readEntriesFromRoot(logDir, filterFn) {
    let entries = [];
    if (!fs.existsSync(logDir)) return entries;
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(logDir, file), 'utf8');
        const lines = raw.trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (!filterFn || filterFn(entry)) entries.push(entry);
          } catch (e) {
            // 跳过损坏行
          }
        }
      } catch (e) {
        // skip unreadable files
      }
    }
    return entries;
  }

  /**
   * 读取某个任务的全量请求链路（logs/requests/<task_id>.jsonl）
   */
  static _readTaskFile(taskId) {
    for (const root of LOG_ROOTS) {
      try {
        const reqFile = path.join(root, 'logs', 'requests', `${taskId}.jsonl`);
        if (!fs.existsSync(reqFile)) continue;
        const raw = fs.readFileSync(reqFile, 'utf8');
        const entries = [];
        for (const line of raw.trim().split('\n').filter(l => l.trim())) {
          try { entries.push(JSON.parse(line)); } catch (e) { /* 跳过损坏行 */ }
        }
        return entries;
      } catch (e) {
        // 尝试下一个根
      }
    }
    return [];
  }

  /**
   * 获取最近日志
   * @param {number} count 数量上限
   */
  static getRecentLogs(count = 100) {
    let allEntries = [];
    for (const root of LOG_ROOTS) {
      allEntries = allEntries.concat(
        this._readEntriesFromRoot(path.join(root, 'logs', 'agent'))
      );
    }
    allEntries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return allEntries.slice(0, count);
  }

  /**
   * 按适配器过滤
   */
  static getLogsByAdapter(adapterName, count = 100) {
    const all = this.getRecentLogs(count * 2);
    return all.filter(e => e.adapter === adapterName).slice(0, count);
  }

  /**
   * 按方向过滤
   */
  static getLogsByDirection(direction, count = 100) {
    const all = this.getRecentLogs(count * 2);
    return all.filter(e => e.direction === direction).slice(0, count);
  }

  /**
   * 按任务 ID 查询全量请求/响应日志（优先读 per-task 文件）
   * @param {string} taskId
   * @param {number} [count] 数量上限（按时间倒序）
   */
  static getLogsByTaskId(taskId, count = 500) {
    const taskEntries = this._readTaskFile(taskId);
    if (taskEntries.length > 0) {
      taskEntries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      return taskEntries.slice(-count);
    }
    // 兜底：扫描全部小时文件
    const all = this._readEntriesFromRoot(path.join(LOG_ROOTS[0], 'logs', 'agent'),
      e => e.task_id === taskId);
    all.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return all.slice(-count);
  }

  /**
   * 按 request_id 查询（请求 + 响应）
   */
  static getLogsByRequestId(requestId) {
    const all = this._readEntriesFromRoot(path.join(LOG_ROOTS[0], 'logs', 'agent'),
      e => e.request_id === requestId);
    all.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return all;
  }

  /**
   * 按对话级 task_id 查询全量请求/响应日志（含协作子任务）
   *
   * 与 getLogsByTaskId 的区别：getLogsByTaskId 只读 <task_id>.jsonl（协作子任务
   * 时是 sub_task_id 文件，不含对话下其他子任务）；本方法优先读 <external_task_id>.jsonl
   * （写入时已聚合该对话下所有子任务的模型调用），实现「一次对话 → 全链路回溯」。
   *
   * @param {string} externalTaskId 对话级 task_id
   * @param {number} [count] 数量上限（按时间倒序）
   */
  static getLogsByExternalTaskId(externalTaskId, count = 500) {
    if (!externalTaskId) return [];
    const taskEntries = this._readTaskFile(externalTaskId);
    if (taskEntries.length > 0) {
      taskEntries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      return taskEntries.slice(-count);
    }
    // 兜底：扫描全部小时文件
    const all = this._readEntriesFromRoot(path.join(LOG_ROOTS[0], 'logs', 'agent'),
      e => e.external_task_id === externalTaskId || e.task_id === externalTaskId);
    all.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return all.slice(-count);
  }

  /**
   * 按事件驱动协作 trace_id 查询全量请求/响应日志
   *
   * trace_id 是 DAG 编排的唯一ID：一次协作的所有子任务（sub_task_id 形如
   * <trace_id>__sub_<seq>）共享同一 trace_id。该方法用于从「协作 trace」
   * 维度回溯一次完整协作中所有模型的调用与失败点。
   *
   * @param {string} traceId 协作 trace_id
   * @param {number} [count] 数量上限（按时间倒序）
   */
  static getLogsByTraceId(traceId, count = 500) {
    if (!traceId) return [];
    const all = this._readEntriesFromRoot(path.join(LOG_ROOTS[0], 'logs', 'agent'),
      e => e.trace_id === traceId || e.task_id === traceId ||
           (String(e.task_id || '').startsWith(traceId + '__sub_')));
    all.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return all.slice(-count);
  }

  /**
   * 查询失败的响应日志（异常请求定位入口）
   * @param {Object} [opts]
   * @param {number} [opts.count] 数量上限
   * @param {string} [opts.task_id] 限定任务
   * @param {string} [opts.agent_name] 限定 Agent
   * @param {string} [opts.error_code] 限定错误码（TIMEOUT/AUTH_REQUIRED/CLI_ERROR/EXECUTION_ERROR/EMPTY_RESPONSE/FATAL）
   */
  static getFailedLogs(opts = {}) {
    const { count = 100, task_id, agent_name, error_code } = opts;
    const entries = task_id
      ? this.getLogsByTaskId(task_id, 2000)
      : this._readEntriesFromRoot(path.join(LOG_ROOTS[0], 'logs', 'agent'),
          e => e.direction === 'response');
    return entries
      .filter(e => e.direction === 'response' && (e.status === 'failed' || e.error_code))
      .filter(e => !task_id || e.task_id === task_id)
      .filter(e => !agent_name || e.agent_name === agent_name)
      .filter(e => !error_code || e.error_code === error_code)
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, count);
  }

  /**
   * 把一个任务下的 请求/响应 条目按 request_id 配对，返回按时间排序的请求对列表
   *
   * @param {string} taskId
   * @returns {Array<{request: Object, response: Object}>} 请求-响应对
   */
  static getRequestPairs(taskId) {
    const entries = this.getLogsByTaskId(taskId, 5000);
    return this.pairEntries(entries);
  }

  /**
   * 把任意 请求/响应 条目列表按 request_id 配对（按时间排序）
   *
   * @param {Array<Object>} entries ModelLogger 条目列表
   * @returns {Array<{request: Object, response: Object}>} 请求-响应对
   */
  static pairEntries(entries) {
    const byReqId = new Map();
    for (const e of entries) {
      if (!e.request_id) continue;
      if (!byReqId.has(e.request_id)) byReqId.set(e.request_id, { request: null, response: null });
      const pair = byReqId.get(e.request_id);
      if (e.direction === 'request') pair.request = e;
      else if (e.direction === 'response' && !pair.response) pair.response = e;
    }
    return Array.from(byReqId.values())
      .filter(p => p.request || p.response)
      .sort((a, b) => {
        const ta = (a.request || a.response).timestamp;
        const tb = (b.request || b.response).timestamp;
        return String(ta).localeCompare(String(tb));
      });
  }
}

module.exports = ModelLogger;
