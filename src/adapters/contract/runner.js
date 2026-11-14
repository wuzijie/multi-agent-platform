/**
 * CLI 进程统一执行器
 *
 * 四个适配器共用的 spawn / 超时 / 取消 / 进程登记逻辑都收敛在这里，
 * 适配器只负责：构造参数、解析 stdout、翻译成规范事件。
 */

const { spawn } = require('child_process');
const procRegistry = require('../../utils/proc-registry');

/**
 * 执行一次 CLI。
 *
 * @param {object} opts
 * @param {string} opts.command         CLI 可执行路径
 * @param {string[]} opts.args          参数
 * @param {string} [opts.prompt]        以位置参数追加到末尾的 prompt（多数 CLI）
 * @param {string} opts.cwd             工作目录
 * @param {object} opts.env             环境变量
 * @param {number} opts.timeoutMs       超时
 * @param {string} opts.taskId          对话 task_id（进程登记 / 停止匹配）
 * @param {(chunk:string)=>void} [opts.onStdoutChunk] 原始增量（用于流式透传）
 * @param {(line:string)=>void} [opts.onStdoutLine]  按行回调（用于 JSON 事件解析）
 * @param {(chunk:string)=>void} [opts.onStderr]
 * @returns {Promise<{exitCode:number|null, cancelled:boolean, timedOut:boolean, stdout:string, stderr:string}>}
 */
function runCli(opts) {
  return new Promise((resolve) => {
    const {
      command, args, prompt, cwd, env, timeoutMs, taskId,
      onStdoutChunk, onStdoutLine, onStderr,
    } = opts;

    const finalArgs = prompt ? [...args, prompt] : [...args];
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let buf = '';
    let settled = false;

    const proc = spawn(command, finalArgs, {
      cwd,
      env,
      timeout: timeoutMs || 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procRegistry.register(proc, taskId);

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (typeof onStdoutChunk === 'function') {
        try { onStdoutChunk(chunk); } catch (e) { /* 消费方异常不影响进程 */ }
      }
      if (typeof onStdoutLine === 'function') {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try { onStdoutLine(line); } catch (e) { /* ignore */ }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (typeof onStderr === 'function') {
        try { onStderr(chunk); } catch (e) { /* ignore */ }
      }
    });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (typeof onStdoutLine === 'function' && buf.trim()) {
        try { onStdoutLine(buf); } catch (e) { /* ignore */ }
        buf = '';
      }
      const cancelled = procRegistry.isUserKilled(proc);
      const timedOut = !cancelled && (exitCode === null
        ? true
        : Date.now() - startedAt >= (timeoutMs || 120000) - 500);
      resolve({
        exitCode,
        cancelled,
        timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    };

    proc.on('close', (code) => finish(code));
    proc.on('error', (err) => {
      stderr += (stderr ? '\n' : '') + err.message;
      finish(-1);
    });
  });
}

module.exports = { runCli };
