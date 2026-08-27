# feat_025 事件驱动协作：右侧任务列表 + 多轮对话

## 需求

1. 任务分解完成时，页面右侧展示子任务列表
2. 任务完成时前面打对勾（✓），未完成空着（□）
3. Agent 接受任务时，任务后标明接受者
4. 同一对话可多次输入（事件驱动模式不结束对话）

## 实现

### 后端

- `src/engine/scheduler.js`：新增 `_emitSubUpdate(traceId, sub, status, agentName)`，
  在子任务状态变化点推送 `collab:subtask:update` 事件：
  - DAG 生成 → 推送全部子任务 PENDING
  - Agent 接受 → 推送 RUNNING（带 agent 名）
  - 完成 → SUCCESS / 失败 → FAILED / 重试 → RETRYING / 超时 → TIMEOUT
- `src/orchestrator/orchestrator.js`：`_executeEventDrivenCollaboration` 完成后
  **保持任务 executing**（不再设为 completed/failed），记录 `task.collab_trace_id`
  为最新回合 trace；失败只记录 suspend_reason，支持用户继续输入或主动结束对话
- `src/api/server.js`：新增 `GET /api/tasks/:taskId/collab/state`，
  按 `task.collab_trace_id` 读黑板返回子任务列表（agent_id → 中文名）

### 前端

- 新增 `CollabTaskPanel` 组件（最右侧 256px 面板）：
  - 每个子任务显示 类型标签（规划/执行/评审/汇总）+ 状态（待执行/执行中/完成…）
  - 展示**任务描述**（子任务指令，换行转空格 + 2 行截断）
  - SUCCESS 打 ✓（绿），未完成显示 □（灰）
  - 已分配显示「接受者: 克劳德」，未分配显示「未分配」
- App 新增 `collabTasks` state：
  - WS 监听 `collab:subtask:update` 实时更新（按 sub_task_id 合并）
  - `fetchConversation` 拉取 collab/state 初始状态
  - 发送新消息时清空（新回合开始），切换/新建对话时重置

## 事件格式

`collab:subtask:update`：`{ task_id, trace_id, sub_task_id, type, status, agent, description }`

`collab:planned`：任务拆解完成，`{ task_id, trace_id, sub_tasks: [{ sub_task_id, type, description }] }`
→ orchestrator 写入对话 `[任务拆解]` 记录（先拆解再分配）

`collab:subtask:done`：子任务执行完成，`{ task_id, trace_id, sub_task_id, type, status, agents_outputs, errors }`
→ orchestrator 写入对话展示各模型输出（`**{类型}子任务**` + 各模型结果）

## 多轮对话

事件驱动模式每轮完成后任务保持 `executing`，用户可继续输入触发新一轮协作
（每次生成新 trace_id，`collab_trace_id` 指向最新一轮），直到用户点「结束对话」。

## 对话展示过程

- 拆解完成 → assistant `**克劳德** 任务拆解\n\n已拆解为 N 个子任务：1. [规划] ...`（显示模型名，非系统）
- 每个子任务完成 → 逐条 assistant `**{模型}** 完成「{类型}」\n\n{完整输出}`
- 全部完成 → `**事件驱动协作结果**`（最终汇总）

## 任务列表时序

拆解后先推送全部子任务（PENDING/待执行）→ 延迟 200ms 再分配执行（RUNNING 显示接受者），
确保任务列表先于执行展示，勾选状态实时更新。
collab/state API 在执行期间按黑板 task_id 扫描最新 trace（不依赖 task.collab_trace_id，
该字段仅在协作完成后写入），保证拆解后任务列表可立即全部查询展示。


