/**
 * 模型调用进程注册表
 *
 * 各适配器 spawn CLI 进程后在此登记（含关联的 task_id），
 * 供「停止当前任务」时只杀该对话的进程（不影响其他对话）。
 */

const _procs = new Map(); // proc -> { taskId, proc }

/** 登记一个子进程（含关联 task_id）；进程结束后自动移除 */
function register(proc, taskId) {
  if (!proc || typeof proc.kill !== 'function') return;
  _procs.set(proc, { taskId: taskId || null, proc });
  proc.once('close', () => _procs.delete(proc));
}

/** 杀死指定 task 的所有在跑进程 */
function killTask(taskId) {
  if (!taskId) return 0;
  let n = 0;
  for (const [proc, info] of _procs) {
    if (info.taskId === taskId) {
      try { proc.kill('SIGKILL'); n++; } catch (e) { /* 忽略已退出 */ }
      _procs.delete(proc);
    }
  }
  return n;
}

/** 批量杀死所有在跑进程（SIGKILL 强杀，全局停止用） */
function killAll() {
  const list = Array.from(_procs.values());
  for (const { proc } of list) {
    try { proc.kill('SIGKILL'); } catch (e) { /* 忽略已退出 */ }
  }
  _procs.clear();
  return list.length;
}

/** 当前在跑的进程数 */
function count() {
  return _procs.size;
}

module.exports = { register, killTask, killAll, count };
