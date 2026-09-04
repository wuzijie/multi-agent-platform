/**
 * 异常请求诊断工具
 *
 * 基于 ModelLogger 记录的请求全生命周期日志，辅助定位异常请求的原因。
 * 提供：
 *   - diagnoseTask(taskId): 输出一个任务的完整请求链路摘要 + 异常点标记
 *   - diagnoseRequest(requestId): 输出单次调用的请求/响应对比
 *   - listFailed(opts): 列出失败请求（可按错误码/Agent/任务过滤）
 *   - buildDiagnosisSummary(opts): 生成可读诊断报告文本
 */
const ModelLogger = require('./model-logger');

/**
 * 错误码 → 中文说明
 */
const ERROR_CODE_LABEL = {
  TIMEOUT: '超时',
  AUTH_REQUIRED: '鉴权失败（未登录/密钥无效）',
  CLI_ERROR: 'CLI 执行错误',
  EXECUTION_ERROR: '执行异常',
  EMPTY_RESPONSE: '空响应',
  FATAL: '致命错误熔断（余额/鉴权）',
  INVALID_ROLE: '非法角色',
  UNKNOWN: '未知错误',
};

/**
 * 单次请求/响应对 → 可读诊断行
 */
function formatPair(pair, index) {
  const req = pair.request;
  const res = pair.response;
  const lines = [];
  const header = req ? `${req.agent_name || req.adapter || 'Agent'} @ ${req.phase || 'initial'} (${req.model || ''})` : '未知调用';
  lines.push(`  [${index}] ${header}`);
  if (req) {
    lines.push(`       req : ${req.timestamp} | prompt=${req.prompt_length} chars | attempt=${req.attempt}`);
  }
  if (res) {
    const statusIcon = res.status === 'success' ? '✅' : '❌';
    const errTag = res.error_code ? ` (${ERROR_CODE_LABEL[res.error_code] || res.error_code})` : '';
    lines.push(`       ${statusIcon} res : ${res.timestamp} | status=${res.status}${errTag} | ${res.duration_ms}ms | content=${res.content_length} chars | exit=${res.exit_code}${res.killed_by_timeout ? ' | 超时被杀' : ''}`);
    if (res.error_message) {
      lines.push(`            error: ${String(res.error_message).slice(0, 300)}`);
    }
  } else {
    lines.push(`       ⚠️ 只有请求，无响应（进程可能被外部杀死/系统崩溃）`);
  }
  return lines.join('\n');
}

/**
 * 诊断一个任务：输出完整请求链路 + 异常标记
 * @param {string} taskId
 * @returns {string} 可读诊断报告
 */
function diagnoseTask(taskId) {
  const pairs = ModelLogger.getRequestPairs(taskId);
  if (pairs.length === 0) {
    return `任务 ${taskId} 没有找到任何请求日志（可能从未调用过模型，或日志目录不可读）。`;
  }

  const out = [];
  out.push(`=== 任务请求链路诊断: ${taskId} ===`);
  out.push(`共 ${pairs.length} 次模型调用\n`);

  let failCount = 0;
  let slowCount = 0;
  pairs.forEach((pair, i) => {
    out.push(formatPair(pair, i + 1));
    const res = pair.response;
    if (res) {
      if (res.status === 'failed' || res.error_code) failCount++;
      if (res.duration_ms > 120000) {
        slowCount++;
        out.push(`       ⚠️ 耗时超过 120 秒，属于慢请求`);
      }
    } else {
      failCount++;
    }
    out.push('');
  });

  out.push(`=== 统计 ===`);
  out.push(`总调用: ${pairs.length} | 异常: ${failCount} | 慢请求(>120s): ${slowCount}`);

  // 异常聚合：按错误码统计
  const errStats = {};
  for (const pair of pairs) {
    const res = pair.response;
    if (res && res.error_code) errStats[res.error_code] = (errStats[res.error_code] || 0) + 1;
  }
  const errKeys = Object.keys(errStats);
  if (errKeys.length > 0) {
    out.push(`\n=== 错误码聚合 ===`);
    for (const code of errKeys) {
      out.push(`  ${code} (${ERROR_CODE_LABEL[code] || '未知'}): ${errStats[code]} 次`);
    }
  }

  return out.join('\n');
}

/**
 * 诊断单次请求（按 request_id）
 */
function diagnoseRequest(requestId) {
  const entries = ModelLogger.getLogsByRequestId(requestId);
  if (entries.length === 0) {
    return `未找到 request_id=${requestId} 的日志。`;
  }
  const req = entries.find(e => e.direction === 'request') || null;
  const res = entries.find(e => e.direction === 'response') || null;
  const pair = { request: req, response: res };
  const out = [];
  out.push(`=== 单次请求诊断: ${requestId} ===`);
  out.push(formatPair(pair, 1));
  if (req) {
    out.push(`\n--- 请求内容（前 1000 字符）---`);
    out.push(String(req.content || '').slice(0, 1000));
  }
  if (res) {
    out.push(`\n--- 响应内容（前 1000 字符）---`);
    out.push(String(res.content || '').slice(0, 1000));
  }
  return out.join('\n');
}

/**
 * 列出失败请求
 */
function listFailed(opts = {}) {
  const failed = ModelLogger.getFailedLogs(opts);
  if (failed.length === 0) {
    return '没有找到失败的请求。';
  }
  const out = [];
  out.push(`=== 失败请求列表 (${failed.length}) ===`);
  for (const e of failed) {
    out.push(
      `  ${e.timestamp} | ${e.agent_name || e.adapter} | ${e.model || ''} | ` +
      `${e.error_code || 'UNKNOWN'} (${ERROR_CODE_LABEL[e.error_code] || ''}) | ${e.duration_ms}ms | ${e.task_id || ''} | ${e.request_id || ''}`
    );
  }
  return out.join('\n');
}

/**
 * 生成可读诊断报告（跨失败请求聚合，面向根因定位）
 *
 * 与 listFailed 的差异：listFailed 只逐条平铺；buildDiagnosisSummary 会
 * 按 错误码 / Agent / 模型 做多维聚合，给出分布占比、Top 异常链路与结论建议，
 * 适合先看整体、再钻取单条。
 *
 * @param {Object} [opts]
 * @param {number} [opts.count] 参与统计的失败条目上限（默认 200）
 * @param {string} [opts.task_id] 限定任务
 * @param {string} [opts.agent_name] 限定 Agent
 * @param {string} [opts.error_code] 限定错误码
 * @returns {string} 可读诊断报告
 */
function buildDiagnosisSummary(opts = {}) {
  const failed = ModelLogger.getFailedLogs({ ...opts, count: opts.count || 200 });
  if (failed.length === 0) {
    return '没有找到失败的请求，无需诊断。';
  }

  const out = [];
  out.push(`=== 异常请求诊断摘要 (${failed.length} 条) ===\n`);

  // 1) 按错误码聚合
  const byCode = {};
  // 2) 按 Agent 聚合
  const byAgent = {};
  // 3) 按模型聚合
  const byModel = {};
  for (const e of failed) {
    const code = e.error_code || 'UNKNOWN';
    byCode[code] = (byCode[code] || 0) + 1;
    const agent = e.agent_name || e.adapter || '(未知)';
    byAgent[agent] = (byAgent[agent] || 0) + 1;
    const model = e.model || '(default)';
    byModel[model] = (byModel[model] || 0) + 1;
  }

  const total = failed.length;
  const pct = (n) => `${Math.round((n / total) * 100)}%`;

  const sortByCount = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  out.push(`--- 按错误码分布 ---`);
  for (const [code, n] of sortByCount(byCode)) {
    out.push(`  ${code} (${ERROR_CODE_LABEL[code] || '未知'}): ${n} 次 (${pct(n)})`);
  }
  out.push('');
  out.push(`--- 按 Agent 分布 ---`);
  for (const [agent, n] of sortByCount(byAgent)) {
    out.push(`  ${agent}: ${n} 次 (${pct(n)})`);
  }
  out.push('');
  out.push(`--- 按模型分布 ---`);
  for (const [model, n] of sortByCount(byModel)) {
    out.push(`  ${model}: ${n} 次 (${pct(n)})`);
  }

  // 4) 平均耗时
  const validDurations = failed.filter(e => typeof e.duration_ms === 'number' && e.duration_ms > 0);
  if (validDurations.length > 0) {
    const avg = Math.round(validDurations.reduce((s, e) => s + e.duration_ms, 0) / validDurations.length);
    const max = Math.max(...validDurations.map(e => e.duration_ms));
    out.push('');
    out.push(`--- 耗时 ---`);
    out.push(`  平均 ${avg}ms | 最长 ${max}ms`);
  }

  // 5) 最近 5 条失败链路（含任务/请求 ID 便于钻取）
  const recent = [...failed].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 5);
  out.push('');
  out.push(`--- 最近失败样本（可用 --task/--request 钻取） ---`);
  for (const e of recent) {
    out.push(
      `  ${e.timestamp} | ${e.agent_name || e.adapter} | ${e.model || ''} | ` +
      `${e.error_code || 'UNKNOWN'} | ${e.duration_ms}ms | task=${e.task_id || '-'} | req=${e.request_id || '-'}`
    );
  }

  // 6) 根因倾向建议
  const topCode = sortByCount(byCode)[0];
  if (topCode) {
    out.push('');
    out.push(`--- 结论建议 ---`);
    switch (topCode[0]) {
      case 'TIMEOUT':
        out.push(`  主要异常为「超时」（${topCode[1]} 次）。建议：检查单次 prompt 长度对应的超时上限、`);
        out.push(`  确认模型 CLI 是否卡在工具调用/长输出、可考虑增大 spawn 超时或拆分任务。`);
        break;
      case 'AUTH_REQUIRED':
        out.push(`  主要异常为「鉴权失败」（${topCode[1]} 次）。建议：检查对应模型的登录态/API Key 是否过期。`);
        break;
      case 'EMPTY_RESPONSE':
        out.push(`  主要异常为「空响应」（${topCode[1]} 次）。建议：检查 prompt 是否让模型进入无输出的分支，或 CLI 流式解析是否失效。`);
        break;
      case 'CLI_ERROR':
        out.push(`  主要异常为「CLI 执行错误」（${topCode[1]} 次）。建议：用 --request <id> 查看具体 stderr/错误消息。`);
        break;
      case 'INVALID_ROLE':
        out.push(`  主要异常为「非法角色」（${topCode[1]} 次）。建议：检查会话消息序列（system/user/assistant 顺序是否错乱）。`);
        break;
      default:
        out.push(`  主要异常为「${topCode[0]}」（${topCode[1]} 次）。建议：用 --request <id> 钻取单条失败详情。`);
    }
  }

  return out.join('\n');
}

module.exports = {
  diagnoseTask,
  diagnoseRequest,
  listFailed,
  buildDiagnosisSummary,
  ERROR_CODE_LABEL,
};
