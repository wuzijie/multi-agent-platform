/**
 * 事件协议与标准消息体模块
 *
 * 按《消息总线+Redis黑板 多Agent协作生产级方案》实现：
 * - 事件常量（方案 §8.2 全量核心事件清单）
 * - 任务类型枚举（方案 §4.4.2）
 * - 标准消息体构建（方案 §2.2，msg_meta / task_context / task_result）
 * - trace_id / msg_id 生成
 *
 * 底层总线复用现有 src/eventbus/bus.js（FileEventBus，EventEmitter+文件持久化），
 * 事件名即 Topic；幂等由黑板模块的 checkAndSetIdempotent 保证。
 */

const { v4: uuidv4 } = require('uuid');

// ===== 事件名常量（方案 §8.2）=====
const EVENTS = {
  // 任务初始化与调度驱动（调度器主导）
  TASK_CREATE: 'TASK_CREATE_EVENT',
  TASK_PLAN_DISPATCH: 'TASK_PLAN_DISPATCH_EVENT',
  TASK_PLAN_FINISH: 'TASK_PLAN_FINISH_EVENT',
  TASK_DEPEND_READY: 'TASK_DEPEND_READY_EVENT',
  SUB_TASK_DISPATCH: 'SUB_TASK_DISPATCH_EVENT',

  // Agent 执行回调（Agent 主导，调度器消费）
  SUB_TASK_SUCCESS: 'SUB_TASK_SUCCESS_EVENT',
  SUB_TASK_FAIL: 'SUB_TASK_FAIL_EVENT',

  // 重试与故障容错
  SUB_TASK_RETRY: 'SUB_TASK_RETRY_EVENT',
  SUB_TASK_TIMEOUT: 'SUB_TASK_TIMEOUT_EVENT',
  AGENT_OFFLINE: 'AGENT_OFFLINE_EVENT',
  TASK_FINAL_FAIL: 'TASK_FINAL_FAIL_EVENT',

  // 任务收尾与终止
  TASK_ALL_FINISH: 'TASK_ALL_FINISH_EVENT',
  TASK_CANCEL: 'TASK_CANCEL_EVENT',

  // 系统运维心跳
  AGENT_HEARTBEAT: 'AGENT_HEARTBEAT_EVENT',

  // 多模型协作讨论（三类模式）
  DISC_START: 'DISC_START_EVENT',         // 讨论开始
  DISC_ROUND_START: 'DISC_ROUND_START',   // 一轮开始 { traceId, round, mode, participants }
  DISC_ROUND_DONE: 'DISC_ROUND_DONE',     // 一轮完成 { traceId, round, summaries }
  DISC_CONVERGED: 'DISC_CONVERGED',       // 讨论收敛 { traceId, consensus, divergences }
  DISC_FAILED: 'DISC_FAILED',             // 讨论失败 { traceId, error }
  DISC_END: 'DISC_END_EVENT',             // 讨论结束
};

// ===== 任务类型枚举（方案 §4.4.2）=====
const TASK_TYPES = {
  PLAN: 'PLAN_TASK',       // 任务规划拆解 → 规划类Agent
  CODE: 'CODE_TASK',       // 代码编写执行 → 代码执行Agent
  REVIEW: 'REVIEW_TASK',   // 内容审核校验 → 评审Agent
  SUMMARY: 'SUMMARY_TASK', // 结果聚合汇总 → 汇总Agent
  DEBUG: 'DEBUG_TASK',     // 问题排查调试 → 调试专项Agent
};

// ===== 子任务状态枚举（方案 §2.4.2）=====
const SUB_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  RETRYING: 'RETRYING',
  TIMEOUT: 'TIMEOUT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
};

// ===== 顶层任务状态枚举（方案 §2.4.1）=====
const TASK_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

// ===== Agent 实例ID映射 =====
const AGENT_IDS = {
  '克劳德': 'claude_agent_01',
  '吉米': 'kimi_agent_01',
  '迪普斯克': 'deepseek_agent_01',
  '钱文': 'qwen_agent_01',
};

const AGENT_NAMES = Object.fromEntries(
  Object.entries(AGENT_IDS).map(([k, v]) => [v, k])
);

/**
 * 生成全局 trace_id（顶层任务唯一ID）
 */
function genTraceId(prefix = 'task') {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}_${ts}_${uuidv4().slice(0, 8)}`;
}

/**
 * 生成子任务ID
 * @param {string} traceId 全局trace_id
 * @param {number} seq 自增序号
 */
function genSubTaskId(traceId, seq) {
  return `${traceId}__sub_${String(seq).padStart(3, '0')}`;
}

/**
 * 生成消息唯一ID（幂等键）
 */
function genMsgId() {
  return uuidv4();
}

/**
 * 构建标准总线消息体（方案 §2.2）
 */
function buildMessage({
  traceId,
  subTaskId = null,
  msgType,
  senderAgent,
  receiverAgent = 'all',
  timeoutMs = 300000,
  retryTimes = 0,
  maxRetry = 3,
  taskInput = {},
  taskDeps = [],
  contextSnapshotKey = null,
  output = {},
  errorMsg = '',
  errorCode = '',
  costMs = 0,
}) {
  return {
    msg_meta: {
      trace_id: traceId,
      sub_task_id: subTaskId,
      msg_id: genMsgId(),
      msg_type: msgType,
      sender_agent: senderAgent,
      receiver_agent: receiverAgent,
      timestamp: Date.now(),
      timeout_ms: timeoutMs,
      retry_times: retryTimes,
      max_retry: maxRetry,
    },
    task_context: {
      task_input: taskInput,
      task_deps: taskDeps,
      context_snapshot_key: contextSnapshotKey,
    },
    task_result: {
      output,
      error_msg: errorMsg,
      error_code: errorCode,
      cost_ms: costMs,
    },
  };
}

/**
 * 判断消息是否幂等重复（消费前置校验）
 * @param {object} blackboard 黑板实例
 * @param {object} msg 标准消息体
 * @param {number} ttlMs 幂等有效期
 */
function isDuplicate(blackboard, msg, ttlMs) {
  const msgId = msg && msg.msg_meta && msg.msg_meta.msg_id;
  if (!msgId) return false;
  return !blackboard.checkAndSetIdempotent(msgId, ttlMs);
}

module.exports = {
  EVENTS,
  TASK_TYPES,
  SUB_STATUS,
  TASK_STATUS,
  AGENT_IDS,
  AGENT_NAMES,
  genTraceId,
  genSubTaskId,
  genMsgId,
  buildMessage,
  isDuplicate,
};
