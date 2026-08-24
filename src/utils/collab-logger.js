const fs = require('fs');
const path = require('path');

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
  if (roots.length === 0) {
    roots.push(path.resolve(__dirname, '..', '..'));
  }
  return roots;
}

const LOG_ROOTS = getLogRoots();

/**
 * 按小时生成日志文件名，如 2026-08-24_19.log
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
 * 内容截断（防日志文件爆炸）
 */
function truncate(content, max = 8000) {
  if (content === null || content === undefined) return '';
  const s = String(content);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断，共 ${s.length} 字符，完整内容见黑板/logs/agent）`;
}

/**
 * 协作链路日志（模型间消息传递追踪）
 *
 * 日志位置：logs/collab/ 目录
 * 文件命名：YYYY-MM-DD_HH.log（按小时滚动，JSONL）
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
 *   "event": "dispatch",
 *   "trace_id": "...",
 *   "sub_task_id": "...",
 *   ...事件特有字段
 * }
 */
class CollabLogger {
  static log(event, data = {}) {
    const now = new Date();
    const entry = {
      timestamp: now.toISOString(),
      event,
      ...data,
    };
    const line = JSON.stringify(entry) + '\n';

    for (const root of LOG_ROOTS) {
      try {
        const logDir = path.join(root, 'logs', 'collab');
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        const logFile = path.join(logDir, hourFileName(now));
        fs.appendFileSync(logFile, line);
      } catch (e) {
        // 某些路径不可写，静默跳过
      }
    }
  }

  /**
   * 规划阶段：DAG 生成
   * @param {string} traceId
   * @param {string} source  'default' | 'llm' | 'llm_fallback'
   * @param {Array}  dag     子任务列表
   * @param {string} userQuery
   */
  static logPlan(traceId, source, dag, userQuery) {
    this.log('plan', {
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
   */
  static logDispatch(traceId, sub, agentNames, upstream = []) {
    this.log('dispatch', {
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
   */
  static logAgentResult(traceId, subTaskId, agent, ok, contentOrError, durationMs) {
    if (ok) {
      this.log('agent_result', {
        trace_id: traceId,
        sub_task_id: subTaskId,
        agent,
        status: 'success',
        content: truncate(contentOrError, 8000),
        duration_ms: durationMs || 0,
      });
    } else {
      this.log('agent_result', {
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
   */
  static logRetry(traceId, subTaskId, retryCount, maxRetry, backoffMs, errorMsg) {
    this.log('retry', {
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
   */
  static logTimeout(traceId, subTaskId, retryCount, action, errorMsg) {
    this.log('timeout', {
      trace_id: traceId,
      sub_task_id: subTaskId,
      retry_count: retryCount,
      action, // 'retry' | 'fail'
      error: truncate(errorMsg, 2000),
    });
  }

  /**
   * 子任务最终失败
   */
  static logSubFail(traceId, subTaskId, errorMsg) {
    this.log('sub_fail', {
      trace_id: traceId,
      sub_task_id: subTaskId,
      error: truncate(errorMsg, 2000),
    });
  }

  /**
   * 顶层任务完结
   */
  static logAllFinish(traceId, status, finalResult, failReason) {
    this.log('all_finish', {
      trace_id: traceId,
      status,
      final_result: truncate(finalResult, 8000),
      fail_reason: truncate(failReason, 2000),
    });
  }
}

module.exports = CollabLogger;
