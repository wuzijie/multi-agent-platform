/**
 * 适配器统一枚举与错误分类
 *
 * 所有适配器只允许产出这里的取值，运行时也只按这里的取值分支，
 * 避免每个适配器各自定义 status/errorCode 导致上游判断分裂。
 */

const STATUS = {
  SUCCESS: 'success',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
};

const ERROR_CODE = {
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  CLI_ERROR: 'CLI_ERROR',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  FATAL: 'FATAL',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
};

const ROLE = {
  EXECUTOR: 'executor',
  REVIEWER: 'reviewer',
  GUARDIAN: 'guardian',
};

const PROMPT_MODE = {
  DELTA: 'delta', // resume 生效：只发游标之后的增量
  FULL: 'full',   // 首次 / 会话失效：全量重建
};

// resume 失效的识别模式（各 CLI 文案不同，统一在这里维护）
const SESSION_MISSING_PATTERNS = [
  /no conversation found/i,
  /session (was )?not found/i,
  /invalid session/i,
  /unknown session/i,
  /could not find (the )?session/i,
  /session expired/i,
  /会话不存在/,
  /会话已过期/,
];

const AUTH_PATTERNS = [/not logged in/i, /unauthorized/i, /invalid api key/i, /authentication/i, /鉴权/];
const RATE_PATTERNS = [/rate limit/i, /too many requests/i, /\b429\b/i];

function matchesAny(patterns, text) {
  if (!text) return false;
  const s = String(text);
  return patterns.some(re => re.test(s));
}

function isSessionMissing(text) {
  return matchesAny(SESSION_MISSING_PATTERNS, text);
}

/**
 * 把进程执行结果分类成统一状态与错误码。
 * @param {{exitCode:number|null, stderr?:string, stdout?:string, cancelled?:boolean, timedOut?:boolean, hasContent?:boolean}} r
 * @returns {{status:string, errorCode?:string, message?:string}}
 */
function classifyRun(r) {
  const stderr = (r && (r.stderr || r.stdout)) || '';

  if (r && r.cancelled) {
    return { status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED, message: '用户已停止本轮任务' };
  }
  if (r && r.timedOut) {
    return { status: STATUS.TIMEOUT, errorCode: ERROR_CODE.TIMEOUT, message: '模型调用超时，进程已被中断' };
  }
  if (isSessionMissing(stderr)) {
    return { status: STATUS.FAILED, errorCode: ERROR_CODE.SESSION_NOT_FOUND, message: '会话已失效（resume 失败）' };
  }
  if (matchesAny(AUTH_PATTERNS, stderr)) {
    return { status: STATUS.FAILED, errorCode: ERROR_CODE.AUTH_REQUIRED, message: stderr.slice(0, 500) };
  }
  if (matchesAny(RATE_PATTERNS, stderr)) {
    return { status: STATUS.FAILED, errorCode: ERROR_CODE.RATE_LIMITED, message: stderr.slice(0, 500) };
  }
  if (r && r.exitCode === 0) {
    if (r.hasContent === false) {
      return { status: STATUS.FAILED, errorCode: ERROR_CODE.EMPTY_RESPONSE, message: '模型返回空内容' };
    }
    return { status: STATUS.SUCCESS };
  }
  return {
    status: STATUS.FAILED,
    errorCode: ERROR_CODE.CLI_ERROR,
    message: String(stderr || 'Unknown error').slice(0, 500),
  };
}

/** 是否属于可重试（换 full 重建 / 换 agent）的错误 */
function isRecoverable(errorCode) {
  return errorCode === ERROR_CODE.SESSION_NOT_FOUND
    || errorCode === ERROR_CODE.TIMEOUT
    || errorCode === ERROR_CODE.RATE_LIMITED
    || errorCode === ERROR_CODE.EMPTY_RESPONSE;
}

module.exports = {
  STATUS,
  ERROR_CODE,
  ROLE,
  PROMPT_MODE,
  SESSION_MISSING_PATTERNS,
  isSessionMissing,
  classifyRun,
  isRecoverable,
};
