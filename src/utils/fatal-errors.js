/**
 * 致命错误分类 + Agent 熔断注册表
 *
 * 问题背景：402（余额不足）/ 401（鉴权失败）/ Invalid role 等"账户级/代码级"错误
 * 重试必然同样失败，但现有三层重试（调度器子任务 3 次重试换模型、skill 维度失败换模型
 * 重试、调度器超时重试）会把这些必败请求反复发送，白白烧 token（2026-08-27 实测：
 * 4 次全 402 的请求全部是无效重试）。
 *
 * 方案：
 * 1. isFatalError(msg)：识别不可通过重试恢复的错误
 * 2. markAgentFatal(agent)：该 Agent（模型通道）出现致命错误后熔断（默认 10 分钟），
 *    期间调度器/技能不再向其派发任务，避免"轮换到死模型再烧一次"
 * 3. 各层短路：调度器遇致命错误直接 FAILED 不重试；skill 换模型时跳过熔断 Agent；
 *    全部 Agent 熔断时快速失败并给出人话原因
 */

const FATAL_RE = /402|insufficient[ _]balance|余额不足|欠费|quota|401|unauthorized|invalid[ _]role|invalid[ _]api[ _]key|无效.*密钥|api key.*invalid/i;

/** 是否致命错误（重试不可能成功） */
function isFatalError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return FATAL_RE.test(msg);
}

const _fatal = new Map(); // agentName -> 熔断到期时间戳
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 熔断 10 分钟（充值/修复后自动恢复）

/** 标记 Agent 熔断（出现致命错误） */
function markAgentFatal(agentName, ttlMs = DEFAULT_TTL_MS) {
  if (!agentName) return;
  _fatal.set(agentName, Date.now() + ttlMs);
}

/** Agent 是否处于熔断中 */
function isAgentFatal(agentName) {
  if (!agentName) return false;
  const t = _fatal.get(agentName);
  if (!t) return false;
  if (Date.now() > t) {
    _fatal.delete(agentName);
    return false;
  }
  return true;
}

/** 解除熔断（充值后可手动调 / 测试用） */
function clearAgentFatal(agentName) {
  if (agentName) _fatal.delete(agentName);
  else _fatal.clear();
}

/** 当前熔断中的 Agent 列表（日志/展示用） */
function fatalAgents() {
  const now = Date.now();
  for (const [k, t] of _fatal) {
    if (now > t) _fatal.delete(k);
  }
  return Array.from(_fatal.keys());
}

module.exports = { isFatalError, markAgentFatal, isAgentFatal, fatalAgents };
