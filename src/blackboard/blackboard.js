/**
 * 黑板模块（Blackboard）— 文件版 Redis 模拟
 *
 * 按《消息总线+Redis黑板 多Agent协作生产级方案》实现：
 * 以本地 JSON 文件模拟 Redis 的 Hash/String/KV + TTL 语义，
 * 零外部依赖，保留方案的分层 Key 规范与持久化能力。
 *
 * Key 规范（与方案一致）：
 *   blackboard:task:{trace_id}:main          顶层任务（Hash）
 *   blackboard:task:{trace_id}:sub:{sub_id}  子任务（Hash）
 *   blackboard:snapshot:{trace_id}           上下文快照（String/JSON）
 *   blackboard:idempotent:{msg_id}           幂等去重（Set，TTL=任务超时）
 *   blackboard:running:{sub_id}              运行中标记（KV，TTL=超时时间）
 *   blackboard:agent:profile:{agent_id}      Agent能力画像（Hash）
 *
 * 存储位置：ROOT/blackboard/{key}.json
 * 数据形态：{ value, expires_at }（expires_at 为毫秒时间戳或 null）
 *
 * 惰性过期：读取时检查 expires_at，已过期则删除并返回空。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BB_DIR = path.join(ROOT, 'blackboard');

function _safeKey(key) {
  if (!key || typeof key !== 'string') {
    throw new Error(`[Blackboard] 非法 key: ${String(key)}`);
  }
  // 防止路径穿越：替换路径分隔符，禁止 .. 片段
  let k = key.replace(/[\\/]/g, '_');
  k = k.split('..').join('__');
  return k;
}

function _filePath(key) {
  return path.join(BB_DIR, `${_safeKey(key)}.json`);
}

function _ensureDir() {
  if (!fs.existsSync(BB_DIR)) {
    fs.mkdirSync(BB_DIR, { recursive: true });
  }
}

/**
 * 读取原始记录（含过期检查）
 */
function _read(key) {
  _ensureDir();
  const fp = _filePath(key);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (raw && raw.expires_at && Date.now() > raw.expires_at) {
      // 惰性删除已过期键
      try { fs.unlinkSync(fp); } catch (e) { /* ignore */ }
      return null;
    }
    return raw || null;
  } catch (e) {
    return null;
  }
}

/**
 * 写入原始记录
 */
function _write(key, value, ttlMs) {
  _ensureDir();
  const fp = _filePath(key);
  const data = {
    value,
    expires_at: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null,
  };
  fs.writeFileSync(fp, JSON.stringify(data));
}

class Blackboard {
  /**
   * 写入 Hash 字段
   * @param {string} key Hash Key
   * @param {string} field 字段名
   * @param {string|number|object} value 值（对象自动 JSON.stringify）
   * @param {number} [ttlMs] 可选整体过期
   */
  hset(key, field, value, ttlMs) {
    const rec = _read(key) || { value: {} };
    if (!rec.value || typeof rec.value !== 'object' || Array.isArray(rec.value)) {
      rec.value = {};
    }
    rec.value[field] = typeof value === 'string' ? value : JSON.stringify(value);
    _write(key, rec.value, ttlMs);
    return 1;
  }

  /**
   * 读取 Hash 字段（自动尝试 JSON 反序列化）
   */
  hget(key, field) {
    const rec = _read(key);
    if (!rec || !rec.value || typeof rec.value !== 'object') return null;
    const v = rec.value[field];
    if (v === undefined) return null;
    return _parseValue(v);
  }

  /**
   * 读取整个 Hash
   */
  hgetall(key) {
    const rec = _read(key);
    if (!rec || !rec.value || typeof rec.value !== 'object') return {};
    const out = {};
    for (const f of Object.keys(rec.value)) {
      out[f] = _parseValue(rec.value[f]);
    }
    return out;
  }

  /**
   * 删除 Hash 字段
   */
  hdel(key, field) {
    const rec = _read(key);
    if (!rec || !rec.value || typeof rec.value !== 'object') return 0;
    if (field in rec.value) {
      delete rec.value[field];
      _write(key, rec.value, rec.expires_at ? rec.expires_at - Date.now() : null);
      return 1;
    }
    return 0;
  }

  /**
   * 写入 String/KV（JSON 序列化）
   */
  set(key, value, ttlMs) {
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    _write(key, v, ttlMs);
    return 'OK';
  }

  /**
   * 带过期写入（等价 set + ttl）
   */
  setex(key, ttlMs, value) {
    return this.set(key, value, ttlMs);
  }

  /**
   * 读取 String/KV（自动 JSON 反序列化）
   */
  get(key) {
    const rec = _read(key);
    if (!rec) return null;
    return _parseValue(rec.value);
  }

  /**
   * 判断 key 是否存在（未过期）
   */
  exists(key) {
    return _read(key) !== null;
  }

  /**
   * 删除 key
   */
  del(key) {
    const fp = _filePath(key);
    if (fs.existsSync(fp)) {
      try { fs.unlinkSync(fp); return 1; } catch (e) { return 0; }
    }
    return 0;
  }

  /**
   * 按前缀列出 key（返回去除 .json 的原始 key）
   */
  keys(prefix = '') {
    _ensureDir();
    const files = fs.readdirSync(BB_DIR).filter(f => f.endsWith('.json'));
    return files
      .map(f => f.slice(0, -'.json'.length))
      .filter(k => k.startsWith(_safeKey(prefix)))
      .filter(k => _read(k) !== null);
  }

  /**
   * 过期时间续期
   */
  expire(key, ttlMs) {
    const rec = _read(key);
    if (!rec) return 0;
    _write(key, rec.value, ttlMs);
    return 1;
  }

  /**
   * 原子幂等检查：不存在则写入并返回 true（已处理）；存在返回 false（重复）
   * @param {string} msgId 消息唯一ID
   * @param {number} ttlMs 幂等有效期（通常=任务超时）
   */
  checkAndSetIdempotent(msgId, ttlMs) {
    const key = `blackboard:idempotent:${msgId}`;
    if (this.exists(key)) return false;
    this.setex(key, ttlMs || 300000, '1');
    return true;
  }
}

function _parseValue(v) {
  if (typeof v !== 'string') return v;
  if (v === '') return '';
  // 尝试 JSON 反序列化
  try {
    return JSON.parse(v);
  } catch (e) {
    return v;
  }
}

module.exports = new Blackboard();
module.exports.Blackboard = Blackboard;
module.exports._filePath = _filePath;
