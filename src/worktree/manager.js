const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Git Worktree Manager
 *
 * 管理 Git worktree 的创建、清理和定时回收
 */
class GitWorktreeManager {
  constructor() {
    this.worktreeRoot = path.join(ROOT, config.git.worktree_root || './workspace');
    this.autoCleanupDays = config.git.auto_cleanup_days || 7;
    this._ensureWorktreeRoot();
  }

  _ensureWorktreeRoot() {
    if (!fs.existsSync(this.worktreeRoot)) {
      fs.mkdirSync(this.worktreeRoot, { recursive: true });
    }
  }

  /**
   * 为指定任务创建 worktree
   */
  async createWorktree(taskId) {
    const worktreePath = path.join(this.worktreeRoot, taskId);

    // 如果已存在，跳过创建
    if (fs.existsSync(worktreePath)) {
      console.log(`[GitWorktree] Worktree already exists: ${worktreePath}`);
      return { success: true, path: worktreePath, created: false };
    }

    const repoUrl = config.git.default_repo_url;
    const branch = config.git.default_branch || 'main';

    try {
      // 检查是否已有主仓库
      const mainRepoPath = path.join(this.worktreeRoot, '.main');
      if (!fs.existsSync(mainRepoPath)) {
        // Clone 主仓库
        await this._git(['clone', '--bare', repoUrl, mainRepoPath]);
      }

      // 创建 worktree
      await this._git([
        '--git-dir', path.join(mainRepoPath),
        'worktree', 'add', worktreePath, branch
      ]);

      console.log(`[GitWorktree] Created worktree for task ${taskId} at ${worktreePath}`);
      return { success: true, path: worktreePath, created: true };
    } catch (e) {
      console.error(`[GitWorktree] Failed to create worktree: ${e.message}`);
      return { success: false, path: worktreePath, error: e.message };
    }
  }

  /**
   * 清理指定任务的 worktree
   */
  async cleanupWorktree(taskId) {
    const worktreePath = path.join(this.worktreeRoot, taskId);

    if (!fs.existsSync(worktreePath)) {
      return { success: true, path: worktreePath, message: 'Worktree does not exist' };
    }

    try {
      const mainRepoPath = path.join(this.worktreeRoot, '.main');
      if (fs.existsSync(mainRepoPath)) {
        // 删除 worktree
        await this._git([
          '--git-dir', path.join(mainRepoPath),
          'worktree', 'remove', worktreePath, '--force'
        ]);
      } else {
        // 没有主仓库，直接删除目录
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }

      console.log(`[GitWorktree] Cleaned up worktree for task ${taskId}`);
      return { success: true, path: worktreePath };
    } catch (e) {
      // 尝试直接删除
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        return { success: true, path: worktreePath };
      } catch (e2) {
        return { success: false, path: worktreePath, error: e2.message };
      }
    }
  }

  /**
   * 定时清理旧 worktree
   * 删除任务状态为失败/终止且超过 auto_cleanup_days 天的 worktree
   */
  async runAutoCleanup() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.autoCleanupDays);
    const cutoffTimestamp = cutoffDate.toISOString();

    console.log(`[GitWorktree] Running auto-cleanup, cutoff: ${cutoffTimestamp}`);

    // 读取任务索引
    const indexPath = path.join(ROOT, 'tasks', 'index.json');
    let tasks = [];
    if (fs.existsSync(indexPath)) {
      tasks = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    }

    const cleanedTasks = [];
    for (const task of tasks) {
      if (['failed', 'terminated'].includes(task.status)) {
        if (task.finished_at && task.finished_at < cutoffTimestamp) {
          await this.cleanupWorktree(task.task_id);
          cleanedTasks.push(task.task_id);
        }
      }
    }

    console.log(`[GitWorktree] Auto-cleanup complete. Cleaned ${cleanedTasks.length} worktrees.`);
    return cleanedTasks;
  }

  /**
   * 列出所有 worktree
   */
  listWorktrees() {
    this._ensureWorktreeRoot();
    const entries = fs.readdirSync(this.worktreeRoot, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({
        task_id: e.name,
        path: path.join(this.worktreeRoot, e.name),
        created_at: fs.statSync(path.join(this.worktreeRoot, e.name)).birthtime.toISOString(),
      }));
  }

  /**
   * 执行 Git 命令
   */
  _git(args) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn('git', args, {
        cwd: ROOT,
        env: { ...process.env },
        timeout: 60000,
      });

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code });
        } else {
          reject(new Error(stderr.trim() || `git exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * 启动定时清理任务（每 24 小时执行一次）
   */
  startAutoCleanupScheduler() {
    // 启动时立即执行一次
    this.runAutoCleanup().catch(e => console.error(`[GitWorktree] Auto-cleanup failed: ${e.message}`));

    // 之后每 24 小时执行
    this._cleanupInterval = setInterval(() => {
      this.runAutoCleanup().catch(e => console.error(`[GitWorktree] Auto-cleanup failed: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  }

  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}

module.exports = new GitWorktreeManager();
