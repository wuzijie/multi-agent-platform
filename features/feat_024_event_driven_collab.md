# feat_024 事件驱动协作（消息总线 + 黑板 + DAG 编排）

## 概述

按《消息总线+Redis黑板 多Agent协作生产级方案》在本地平台落地**事件驱动协作模式**：
统一调度器拆解 DAG（规划→执行→评审→汇总），子任务按依赖关系事件驱动调度，
由 Agent 能力画像匹配分发，状态全部写入黑板（文件版 Redis 模拟），
支持幂等、重试、超时、心跳，实现可追溯、可断点续跑的协作闭环。

## 触发方式

前端输入区选择「协作模式：事件驱动」，发送任意消息即进入该模式。
也可通过 API 传 `collab_mode: 'event-driven'` 触发。

## 架构组件

| 组件 | 文件 | 职责 |
|------|------|------|
| 黑板 | `src/blackboard/blackboard.js` | 文件版 Redis 模拟，分层 Key + TTL 惰性过期 |
| 事件协议 | `src/engine/events.js` | 事件常量、任务类型、标准消息体（msg_meta/task_context/task_result） |
| 统一调度器 | `src/engine/scheduler.js` | 唯一状态决策者：DAG 解析、能力匹配、重试、超时、心跳 |
| 编排集成 | `src/orchestrator/orchestrator.js` | `_executeEventDrivenCollaboration` 入口 + 流式 executor |

## 数据流（事件驱动闭环）

```
用户请求 → TASK_CREATE_EVENT → 调度器写顶层任务(PENDING→RUNNING)
→ 规划(默认DAG) → 批量写子任务(PENDING) → 依赖就绪检测
→ 能力画像匹配Agent → SUB_TASK_DISPATCH → 子任务RUNNING + running僵尸Key
→ Agent执行(流式) → SUB_TASK_SUCCESS/FAIL → 更新黑板 → 触发下一轮就绪
→ 全部完成 → TASK_ALL_FINISH → 汇总写顶层SUCCESS → 结果回写对话
```

## 黑板 Key 规范

- `blackboard:task:{trace_id}:main` — 顶层任务（Hash）
- `blackboard:task:{trace_id}:sub:{sub_id}` — 子任务（Hash）
- `blackboard:snapshot:{trace_id}` — 上下文快照
- `blackboard:idempotent:{msg_id}` — 幂等去重（TTL）
- `blackboard:running:{sub_id}` — 运行中标记/僵尸检测（TTL）
- `blackboard:agent:profile:{agent_id}` — Agent 能力画像

## 容错机制

- **主agent拆解分配**：由主 agent（克劳德）调用 LLM 拆解任务为 DAG 子任务，
  并为每个子任务指定执行模型（`agent` 字段）；每个子任务一般只分配给一个模型，
  指定模型不可用时回退能力画像匹配
- **失败重试**：指数退避 1s/3s/5s/10s，最多 3 次
- **超时回收**：RUNNING 超过 timeout_ms 标记 TIMEOUT，重新调度，超时 3 次判失败
- **幂等去重**：消息唯一 msg_id + 黑板幂等 Key
- **心跳**：每 5s 更新 Agent 画像，离线任务自动等待/重分配

## 待办/说明

- 沙箱不可用期间未运行端到端测试，需本地 `npm start` 后验证
- `plannerMode` 目前为 `'default'`（内置标准 DAG）；可切换 `'llm'` 接入真实规划 Agent
