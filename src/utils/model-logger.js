const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LogStore = require('./log-store');

/**
 * 日志根目录候选列表（与 LogStore 一致：/Volumes 优先，回退项目根）
 */
const LOG_ROOTS = LogStore.LOG_ROOTS;

/**
 * 生成全局唯一请求 ID：req_<时间戳36进制>_<4字节随机hex>
 * 用于把 一次模型调用的 请求(request) 与 响应(response/error) 关联成对，
 * 并在多轮 tool round / 重试之间区分每一次独立的 CLI 调用。
 */
function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

/** 是否为模型请求/响应日志条目（新结构同一会话文件中混有其他类别日志） */
function isModelEntry(e) {
  return !!e && (e.log_type === 'model' || e.direction === 'request' || e.direction === 'response');
}

/**
 * 模型 CLI 请求/响应日志记录器（请求全生命周期版）
 *
 * 日志位置（按会话划分，按天收录）：
 *   logs/YYYY-MM-DD/<session_id>.log  —— 该会话当天的全部日志（JSONL）
 *     session_id = 对话级 task_id（external_task_id）：
 *     模型请求/响应、协作链路、事件总线、埋点都写进同一会话文件。
 *   logs/YYYY-MM-DD/_system.log       —— 无会话归属的日志
 *
 * 条目核心字段：
 * {
 *   "timestamp": "2026-08-12T10:30:00.123Z",
 *   "log_type": "model",                  // 日志类别（model / collab / event / analytics）
 *   "session_id": "conv_xxx",             // 会话 ID（对话级 task_id；无会话为空串）
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
 * 旧结构（仅作为历史日志的读取兜底，不再写入）：
 *   logs/agent/YYYY-MM-DD_HH.log           —— 按小时全量流（跨会话）
 *   logs/requests/<task_id>.jsonl           —— 按任务聚合
 */
class ModelLogger {
  /**
   * 写一条日志：追加到该条目所属会话的当天日志文件
   * 会话归属：external_task_id（对话级）优先，其次 task_id；都没有则进 _system.log
   */
  static _write(entry) {
    const sessionId = entry.external_task_id || entry.task_id || '';
    LogStore.append(sessionId, Object.assign({ log_type: 'model' }, entry));
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
   * @param {string} [meta.external_task_id] 对话级 task_id（会话维度聚合）
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
   * 读取旧结构某个根目录下所有小时文件中的条目（历史日志兜底）
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
   * 读取旧结构按任务聚合的文件（logs/requests/<task_id>.jsonl，历史日志兜底）
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

  /** 旧结构全量扫描（历史日志兜底） */
  static _readLegacy(filterFn) {
    let all = [];
    for (const root of LOG_ROOTS) {
      all = all.concat(this._readEntriesFromRoot(path.join(root, 'logs', 'agent'), filterFn));
    }
    return all;
  }

  /**
   * 获取最近日志（新结构优先，无结果时回退旧结构）
   * @param {number} count 数量上限
   */
  static getRecentLogs(count = 100) {
    const entries = LogStore.readRecent(isModelEntry, count);
    if (entries.length > 0) return entries;
    const legacy = this._readLegacy();
    legacy.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return legacy.slice(0, count);
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
   * 按任务 ID 查询全量请求/响应日志
   *
   * taskId 为对话级 ID 时直接读该会话文件（含其下所有子任务）；
   * 为子任务 ID 时全量扫描按 task_id 匹配；仍为空时回退旧结构。
   *
   * @param {string} taskId
   * @param {number} [count] 数量上限（按时间倒序）
   */
  static getLogsByTaskId(taskId, count = 500) {
    // 1) 会话文件直接命中（taskId 即对话 ID）
    let entries = LogStore.readSessionEntries(taskId).filter(isModelEntry);
    // 2) 子任务 ID：全量扫描
    if (entries.length === 0) {
      entries = LogStore.scanEntries(
        e => isModelEntry(e) && (e.task_id === taskId || e.external_task_id === taskId),
        { limit: 5000 }
      );
    }
    // 3) 旧结构兜底
    if (entries.length === 0) entries = this._readTaskFile(taskId);
    entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return entries.slice(-count);
  }

  /**
   * 按 request_id 查询（请求 + 响应）
   */
  static getLogsByRequestId(requestId) {
    let entries = LogStore.scanEntries(e => isModelEntry(e) && e.request_id === requestId);
    if (entries.length === 0) {
      entries = this._readLegacy(e => e.request_id === requestId);
    }
    entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return entries;
  }

  /**
   * 按对话级 task_id 查询全量请求/响应日志（含协作子任务）
   *
   * 读取该会话文件（写入时已按会话聚合），实现「一次对话 → 全链路回溯」。
   *
   * @param {string} externalTaskId 对话级 task_id
   * @param {number} [count] 数量上限（按时间倒序）
   */
  static getLogsByExternalTaskId(externalTaskId, count = 500) {
    if (!externalTaskId) return [];
    let entries = LogStore.readSessionEntries(externalTaskId).filter(isModelEntry);
    if (entries.length === 0) {
      entries = LogStore.scanEntries(
        e => isModelEntry(e) && e.external_task_id === externalTaskId,
        { limit: 5000 }
      );
    }
    if (entries.length === 0) entries = this._readTaskFile(externalTaskId);
    entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return entries.slice(-count);
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
    const match = (e) => isModelEntry(e) && (
      e.trace_id === traceId || e.task_id === traceId ||
      String(e.task_id || '').startsWith(traceId + '__sub_')
    );
    let entries = LogStore.scanEntries(match);
    if (entries.length === 0) entries = this._readLegacy(match);
    entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return entries.slice(-count);
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
    let entries;
    if (task_id) {
      entries = this.getLogsByTaskId(task_id, 5000);
    } else {
      entries = LogStore.scanEntries(e => isModelEntry(e) && e.direction === 'response');
      if (entries.length === 0) entries = this._readLegacy(e => e.direction === 'response');
    }
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
