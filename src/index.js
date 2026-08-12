#!/usr/bin/env node

/**
 * 多智能体协作平台 - 主入口
 *
 * 启动流程：
 * 1. 加载所有配置文件
 * 2. 初始化 Agent Runtime（启动心跳检测）
 * 3. 启动 API Server（HTTP + WebSocket）
 * 4. 启动 Git Worktree 定时清理
 * 5. 初始化特性清单系统
 */

const config = require('./utils/config');
const agentRuntime = require('./agent/runtime');
const apiServer = require('./api/server');
const worktreeManager = require('./worktree/manager');
const featureManager = require('./features/manager');

async function main() {
  console.log('========================================');
  console.log('  多智能体协作平台 v1.0.0');
  console.log('  Multi-Agent Collaboration Platform');
  console.log('========================================');
  console.log('');

  // 1. 加载配置
  console.log('[Bootstrap] Loading configuration...');
  config.loadAll();
  console.log(`[Bootstrap] Loaded ${config.agents.length} agent(s), ${config.users.length} user(s)`);
  console.log(`[Bootstrap] Git repo: ${config.git.default_repo_url}`);

  // 2. 初始化 Agent Runtime
  console.log('[Bootstrap] Initializing agent runtime...');
  await agentRuntime.initialize();
  const defaultAgent = config.getDefaultAgent();
  console.log(`[Bootstrap] Default agent: ${defaultAgent ? defaultAgent.name : 'None'}`);

  // 3. 初始化特性清单
  console.log('[Bootstrap] Initializing feature manager...');
  const features = featureManager.listFeatures();
  console.log(`[Bootstrap] ${features.length} feature(s) in registry`);

  // 4. 启动 Worktree 定时清理
  console.log('[Bootstrap] Starting worktree auto-cleanup scheduler...');
  worktreeManager.startAutoCleanupScheduler();

  // 5. 启动 API Server
  console.log('[Bootstrap] Starting API server...');
  await apiServer.start();

  console.log('');
  console.log('[Bootstrap] Platform is ready!');
  console.log(`[Bootstrap] Open http://localhost:${apiServer.port} in your browser`);
  console.log('');

  // 优雅关闭
  process.on('SIGINT', () => {
    console.log('\n[Shutdown] Shutting down gracefully...');
    agentRuntime.stop();
    worktreeManager.stop();
    apiServer.stop();
    console.log('[Shutdown] Goodbye!');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[Shutdown] Shutting down gracefully...');
    agentRuntime.stop();
    worktreeManager.stop();
    apiServer.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Bootstrap] Fatal error:', err);
  process.exit(1);
});
