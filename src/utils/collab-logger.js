const LogStore = require('./log-store');

/**
 * 内容截断（防日志文件爆炸）
 */
function truncate(content, max = 8000) {
  if (content === null || content === undefined) return '';
  const s = String(content);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断，共 ${s.length} 字符，完整内容见黑板/会话日志）`;
}

/**
 * 协作链路日志（模型间消息传递追踪）
 *
 * 日志位置：logs/YYYY-MM-DD/<session_id>.log（按天文件夹、按会话文件，JSONL）
 *   —— 与模型请求/响应日志共用同一会话文件，用 log_type="collab" 区分；
 *      无会话归属时写入 logs/YYYY-MM-DD/_system.log。
 *
 * 记录事件驱动协作的完整消息流：
 *   plan        规划阶段：DAG 生成（来源 + 子任务列表 + 依赖关系）
 *   dispatch    调度下发：子任务 → 模型分配 + 注入的上游模型输出（模型间通信核心）
 *   agent_result 单个模型执行结果（成功内容 / 失败原因 + 耗时）
 *   retry       重试（次数 + 退避 + 失败原因）
 *   timeout     超时处理（重试 or 判失败）
 *   sub_fail    子任务最终失败（重试耗尽）
 *   all_finish  顶层任务完结（成功 / 失败 + 汇总）
 *
 * 条目格式（每行一条 JSON）：
 * {
 *   "timestamp": "2026-08-24T11:50:11.066Z",
 *   "log_type": "collab",
 *   "session_id": "conv_xxx",   // 会话 ID（对话级 task_id）
 *   "event": "dispatch",
 *   "trace_id": "...",
 *   "sub_task_id": "...",
 *   ...事件特有字段
 * }
 */
class CollabLogger {
  /**
   * 追加一条协作日志
   *
   * @param {string} event 事件名
   * @param {Object} [data] 事件数据；会话归属取 data.session_id / external_task_id / task_id
   */
  static log(event, data = {}) {
    const sessionId = data.session_id || data.external_task_id || data.task_id || '';
    const entry = Object.assign({ log_type: 'collab', event }, data, {
      session_id: sessionId,
    });
    LogStore.append(sessionId, entry);
  }

  /**
   * 规划阶段：DAG 生成
   * @param {string} traceId
   * @param {string} source  'default' | 'llm' | 'llm_fallback'
   * @param {Array}  dag     子任务列表
   * @param {string} userQuery
   * @param {string} [sessionId] 会话 ID（对话级 task_id）
   */
  static logPlan(traceId, source, dag, userQuery, sessionId) {
    this.log('plan', {
      session_id: sessionId || '',
      trace_id: traceId,
      source,
      user_query: truncate(userQuery, 2000),
      sub_tasks: (dag || []).map(d => ({
        sub_task_id: d.id,
        type: d.type,
        agent: d.agent || '',
        deps: d.deps || [],
        instruction: truncate(d.instruction, 2000),
      })),
    });
  }

  /**
   * 调度下发：模型分配 + 上游输出注入（模型间消息传递核心记录）
   * @param {string} traceId
   * @param {object} sub       黑板子任务
   * @param {Array}  agentNames 被分配的模型中文名列表
   * @param {Array}  upstream   注入的上游输出摘要 [{ dep_id, agents, chars, preview }]
   * @param {string} [sessionId] 会话 ID（对话级 task_id）
   */
  static logDispatch(traceId, sub, agentNames, upstream = [], sessionId) {
    this.log('dispatch', {
      session_id: sessionId || '',
      trace_id: traceId,
      sub_task_id: sub.sub_task_id,
      type: sub.type || '',
      role: sub.role || 'executor',
      from_agents: upstream.map(u => u.agents).filter(Boolean),
      agents: agentNames,
      instruction: truncate(sub.input || sub.instruction, 2000),
      upstream_outputs: upstream.map(u => ({
        dep_id: u.dep_id,
        agents: u.agents,
        chars: u.chars,
        preview: truncate(u.preview, 2000),
      })),
    });
  }

  /**
   * 单个模型执行结果
   * @param {string} [sessionId] 会话 ID（对话级 task_id）
   */
  static logAgentResult(traceId, subTaskId, agent, ok, contentOrError, durationMs, sessionId) {
    if (ok) {
      this.log('agent_result', {
        session_id: sessionId || '',
        trace_id: traceId,
        sub_task_id: subTaskId,
        agent,
        status: 'success',
        content: truncate(contentOrError, 8000),
        duration_ms: durationMs || 0,
      });
    } else {
      this.log('agent_result', {
        session_id: sessionId || '',
        trace_id: traceId,
        sub_task_id: subTaskId,
        agent,
        status: 'failed',
        error: truncate(contentOrError, 2000),
        duration_ms: durationMs || 0,
      });
    }
  }

  /**
   * 重试
   * @param {string} [sessionId] 会话 ID（对话级 task_id）
   */
  static logRetry(traceId, subTaskId, retryCount, maxRetry, backoffMs, errorMsg, sessionId) {
    this.log('retry', {
      session_id: sessionId || '',
      trace_id: traceId,
      sub_task_id: subTaskId,
      retry_count: retryCount,
      max_retry: maxRetry,
      backoff_ms: backoffMs,
      error: truncate(errorMsg, 2000),
    });
  }

  /**
   * 超时处理
   * @param {string} [sessionId] 会话 ID（对话级 task_id）
   */
  static logTimeout(traceId, subTaskId, retryCount, action, errorMsg, sessionId) {
    this.log('timeout', {
      session_id: sessionId || '',
      trace_id: traceId,
      sub_task_id: subTaskId,
      retry_count: retryCount,
      action, // 'retry' | 'fail'
      error: truncate(errorMsg, 2000),
    });
  }

  /**
   * 子任务最终失败
   * @param {string} [sessionId] 会话 ID（对话级 task_id）
   */
  static logSubFail(traceId, subTaskId, errorMsg, sessionId) {
    this.log('sub_fail', {
      session_id: sessionId || '',
      trace_id: traceId,
      sub_task_id: subTaskId,
      error: truncate(errorMsg, 2000),
    });
  }

  /**
   * 顶层任务完结
   * @param {string} [sessionId] 会话 ID（对话级 task_id）
   */
  static logAllFinish(traceId, status, finalResult, failReason, sessionId) {
    this.log('all_finish', {
      session_id: sessionId || '',
      trace_id: traceId,
      status,
      final_result: truncate(finalResult, 8000),
      fail_reason: truncate(failReason, 2000),
    });
  }
}

module.exports = CollabLogger;
