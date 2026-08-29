# feat_033: 对话级会话隔离（Session Manager）+ 多对话并行

## 概述

所有对话相互独立、互不影响，各有自己的 thread（消息历史，已按 task 隔离）与 session（运行时状态：活跃 trace、占用模型、状态）。新增显式 Session 实体集中管理每个对话的运行状态，并实现「同一模型一次只服务一个对话」的并发闸门，不同对话可用不同模型并行执行。

## 核心文件

| 文件 | 说明 |
|------|------|
| `src/session/manager.js` | SessionManager + Session：按 task_id 隔离运行态（traces / busyAgents / status）；`isAgentBusyByOther()` 跨会话占用判定；`registerTrace/releaseTrace`；`stopAll()` |
| `src/agent/runtime.js` | BUSY 闸门：目标模型被其他会话占用时返回 `{code:'BUSY'}` 拒绝并发；模型占用/释放记账到 Session（occupy/release） |
| `src/engine/scheduler.js` | `createTask` 注册 trace、`_resolveTask` 释放；子任务收到 BUSY 不计入重试、3s 后重派（避免 3 次 BUSY 判死） |
| `src/skills/deep-research.js` | `run` 注册 trace、`_finish` 释放；skill 内部并行调研不同模型不受 BUSY 影响 |
| `src/orchestrator/orchestrator.js` | `executeSimpleTask` 标记 session 活跃；`terminateTask` 标记 completed；`stopAllTasks` 增加 `sessionManager.stopAll()` |
| `src/api/server.js` | `GET /api/sessions` 查询会话状态 |

## 隔离语义

- **数据层**（已有）：conversation.md 按 task_id 文件隔离；对话历史 `_readConversationHistory(taskId)` 每任务读取；事件按 task_id 路由；前端按 activeId 过滤（convSeqRef / activeIdRef 防竞态）
- **运行时层**（本次新增）：每个对话一个 Session，记录其活跃 trace 与占用模型（观察/审计用）
- **多对话可并发使用同一模型 CLI**（2026-08-27 修订）：不设 BUSY 闸门——每次调用都 spawn 新的 CLI 进程，不同对话可同时调用同一模型。`agent.busy` 改用计数维护（`_busyCount`），并发调用全部结束后才置空闲，避免一个调用结束误清其他调用的 busy 状态；调度器 `_matchAgents` 不再排除 busy 模型（`p.status !== 'offline'` 即可选）
- **多对话并行**：不同对话用不同模型或同一模型均可同时执行，互不阻塞

## 停止全部

`POST /api/tasks/stop-all` 现在同时：取消调度器 trace、取消 skill trace、SIGKILL CLI 进程、清空所有 session（busyAgents/traces/status）、executing 任务标 completed。

## 验证

- `outputs/test-session-isolation.js`：session 记账、跨会话 busy 记录（仅观察）、并发同模型可执行、busy 计数归零
- `outputs/test-fc-loop.js` / `test-deep-research.js`：FC 循环与 skill 5 步闭环无回归

## 状态

已完成，2026-08-27（未提交，按用户偏好留工作区）
