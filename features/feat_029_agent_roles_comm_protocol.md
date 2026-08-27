# 多 Agent 角色职责与协作通信协议设计

> 关联方案：`features/feat_028_multi_agent_collaboration_plan.md`
> 本文聚焦「角色职责 / 能力边界 / 通信协议 / 消息格式」四件事，所有约定与现有实现
> （`src/engine/events.js`、`src/engine/scheduler.js`、`src/blackboard/blackboard.js`、
> `src/eventbus/bus.js`、`src/agent/runtime.js`）保持一致。

---

## 一、角色总览（Role Map）

平台由「系统组件角色」和「Agent 协作角色」两类角色构成。系统组件是常驻代码模块，
Agent 协作角色是模型在某个子任务中临时扮演的身份。

```
                          ┌──────────────────────────────┐
                          │  Orchestrator（编排器）        │
                          │  模式路由 / 对话 / 流式回写     │
                          └──────────────┬───────────────┘
                                         │ 模式路由
                 ┌───────────────────────┼───────────────────────┐
                 ▼                       ▼                       ▼
        ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
        │ Scheduler（调度器）│      │  Agent Runtime │      │  Skill 层       │
        │ 唯一状态决策者    │◄────►│ 生命周期/心跳    │      │ 标准化技能闭环   │
        └───────┬────────┘      └───────┬────────┘      └────────────────┘
                │ 事件驱动               │ 调用适配器
                ▼                       ▼
        ┌────────────────┐      ┌────────────────┐
        │ Blackboard（黑板）│      │ Model Adapters │
        │ 状态持久化 + TTL  │      │ claude/kimi/…  │
        └────────────────┘      └────────────────┘
                ▲                       ▲
                └──────── Event Bus ─────┘
```

---

## 二、系统组件角色职责

### 2.1 Orchestrator（任务编排器）

**职责**
- 任务生命周期入口：创建任务、复杂度判别（可被 `multi_agent` 显式覆盖）。
- 协同模式路由：
  - 单 Agent（含 `@单Agent` 粘性选择）
  - `@多Agent` 循环讨论
  - `collab_mode=event-driven` 事件驱动
  - `skill=deep_research` 深度调研
- 对话记录唯一写入方：所有用户/助手/系统消息写 `tasks/{task_id}/conversation.md`。
- 流式事件回写：把模型增量输出以 `agent:stream:start/chunk/end` 推送前端。
- 模型间 `@Agent名` 转交提取与 3 跳防循环。

**不做**
- 不直接决定子任务状态（PENDING/RUNNING/SUCCESS…），该权力属于 Scheduler。
- 不维护子任务 DAG 与依赖（仅调用 Scheduler.createTask 并消费最终结果）。

### 2.2 Scheduler（统一调度器）

**职责**
- 唯一状态决策者：所有子任务状态变更由 Scheduler 统一写黑板，Agent 只执行不写状态。
- DAG 生成与解析（LLM 规划失败回退默认 DAG）。
- 依赖就绪检测：子任务「所有依赖 = SUCCESS」才可下发。
- 能力画像匹配 + 轮转 + 负载均衡。
- 重试（指数退避）、超时（僵尸检测）、幂等去重、心跳维护。
- 上游输出注入下游上下文（单上游上限 8000 字符）。
- 汇总：`SUMMARY_TASK` 输出作为顶层 `final_result`。

**不做**
- 不直接调用模型 CLI（通过注入的 `executor` → AgentRuntime 间接调用）。
- 不写对话记录。
- 不处理前端 WebSocket 协议（只发 `collab:*` 事件，由 Orchestrator 消费回写）。

### 2.3 Agent Runtime（Agent 运行时）

**职责**
- 管理四类 Agent 实例（克劳德/吉米/迪普斯克/钱文）的注册与生命周期。
- 健康检查与心跳（5s 周期），维护 `online / busy / current_task / latency_ms`。
- 按 `agentName` 执行任务，并在指定 Agent 离线/不存在时回退克劳德。

**不做**
- 不做任务拆解、依赖管理、结果汇总。
- 不写黑板；只向上层返回 `UnifiedOutput`。

### 2.4 Blackboard（黑板）

**职责**
- 提供文件版 Redis 模拟的 KV/Hash + TTL 语义。
- 状态持久化、惰性过期、幂等键（`checkAndSetIdempotent`）。

**不做**
- 不感知业务状态机；只提供原子读写的存储原语。

### 2.5 Event Bus（事件总线）

**职责**
- 内存 EventEmitter + 文件持久化（`logs/events/`）。
- 事件名即 Topic；支持 `*` 通配订阅。

**不做**
- 不做业务路由、不做消息重放（当前实现为 append-only，重放需另扩展）。

---

## 三、Agent 协作角色与四模型能力边界

### 3.1 协作角色（模型可临时扮演）

| 角色 | 英文 | 职责 | 边界 |
|------|------|------|------|
| 规划者 | planner | 拆解用户请求为 DAG、指定执行模型 | 只产出计划，不写代码 |
| 执行者 | executor | 完成具体子任务并产出结果 | 按指令执行，不评判他人 |
| 评审者 | reviewer | 评审产出，输出「可行/需修改」+ 意见 | 只评审，不直接修改答案 |
| 汇总者/愿景守护者 | guardian/summarizer | 综合上游产出与评审，产出最终答案，确保不偏离原始目标 | 不新增未经验证的事实 |
| 裁决者 | arbiter | 评审意见冲突时裁决（少数服从多数，均等时克劳德裁决） | 仅在讨论/复杂任务闭环中出现 |

> `agents.yaml` 中四模型的能力标签经 `CAP_TO_TASK_TYPES` 映射为可执行任务类型，
> 调度器据此做「能力画像匹配」。所有模型默认具备 `REVIEW_TASK` / `SUMMARY_TASK` 通用能力。

### 3.2 四模型能力边界

| 模型 | 默认主角色 | 能力标签（agents.yaml） | 建议承担 | 建议回避 |
|------|-----------|------------------------|---------|---------|
| 克劳德 Claude | planner / guardian | logic、complex_code、architecture、text_refinement | 复杂架构、规划拆解、代码规范、最终汇总 | 高频简单任务的低延迟执行 |
| 吉米 Kimi | reviewer / summarizer | long_text、information_extraction、documentation | 长文档分析、信息提炼、文档生成 | 复杂算法优化 |
| 迪普斯克 DeepSeek | executor（代码） | algorithm、performance、bug_detection、deep_tech | 算法实现、调试纠错、性能优化、漏洞排查 | 通用文本创作 |
| 钱文 Qwen | executor（快速迭代） | lightweight_dev、fast_iteration、scenario_fitting、chinese_optimization | 快速开发、场景适配、中文表达优化 | 超复杂架构设计 |

**边界约定**
1. 能力画像来自 `agents.yaml`，是「建议」而非「强制」；离线时调度器回退到其他在线模型。
2. `preferred_agent`（主 Agent 拆解时指定）优先于能力画像匹配；指定的 Agent 不在线则回退画像匹配。
3. 一个子任务当前只分配一个 Agent（`agentsPerTask = 1`），预留多 Agent 同子任务的扩展位（`agents[]`）。

---

## 四、通信协议总览

四条通信通道：

| 通道 | 载体 | 用途 | 写入方 |
|------|------|------|--------|
| 事件总线 | `src/eventbus/bus.js` + `logs/events/` | 任务分配、状态上报、心跳、终止、流式输出 | 所有组件 |
| 黑板 | `src/blackboard/blackboard.js` | 共享状态、幂等、运行中标记、能力画像 | Scheduler（业务状态）、Blackboard API |
| 对话记录 | `tasks/{task_id}/conversation.md` | 面向用户的最终呈现 | Orchestrator |
| 协作日志 | `logs/collab/*.log` | 模型间消息传递追踪 | CollabLogger |

**通信规则**
- **单写者原则**：`blackboard:task:*` 业务状态仅 Scheduler 写入；Agent/Orchestrator 只读。
- **事件即事实**：状态变更必须通过事件广播，黑板仅是事件的持久化投影。
- **幂等**：所有事件带 `msg_id`，消费者先 `isDuplicate()` 再处理。
- **有向路由**：`sender_agent → receiver_agent`；`receiver_agent = 'all'` 表示广播。

---

## 五、统一消息信封（Standard Envelope）

所有总线消息采用三段式信封，定义于 `src/engine/events.js` 的 `buildMessage()`：

```json
{
  "msg_meta": {
    "trace_id": "task_20260825_192549_929c640c",
    "sub_task_id": "task_20260825_192549_929c640c__sub_001",
    "msg_id": "uuid-v4",
    "msg_type": "SUB_TASK_SUCCESS_EVENT",
    "sender_agent": "scheduler",
    "receiver_agent": "scheduler",
    "timestamp": 1756131600000,
    "timeout_ms": 300000,
    "retry_times": 0,
    "max_retry": 3
  },
  "task_context": {
    "task_input": { "user_query": "制定一个多agent协同工作的方案" },
    "task_deps": ["task_...__sub_000"],
    "context_snapshot_key": null
  },
  "task_result": {
    "output": { "content": "..." },
    "error_msg": "",
    "error_code": "",
    "cost_ms": 12345
  }
}
```

字段语义：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `msg_meta.trace_id` | string | 是 | 顶层任务唯一 ID |
| `msg_meta.sub_task_id` | string\|null | 否 | 子任务 ID；顶层事件为 null |
| `msg_meta.msg_id` | string(uuid) | 是 | 幂等键，消费者去重 |
| `msg_meta.msg_type` | string | 是 | 事件类型（见 §六） |
| `msg_meta.sender_agent` | string | 是 | 发送方（Agent 名或 `scheduler`/`orchestrator`） |
| `msg_meta.receiver_agent` | string | 是 | 接收方；`all` 为广播 |
| `msg_meta.timeout_ms` | number | 否 | 本消息/任务的超时预算 |
| `msg_meta.retry_times` | number | 否 | 已重试次数 |
| `msg_meta.max_retry` | number | 否 | 最大重试次数 |
| `task_context.task_input` | object | 否 | 任务输入 |
| `task_context.task_deps` | string[] | 否 | 依赖的子任务 ID 列表 |
| `task_context.context_snapshot_key` | string\|null | 否 | 上下文快照 key |
| `task_result.output` | object | 否 | 结果输出（`{content}`） |
| `task_result.error_msg` | string | 否 | 错误信息 |
| `task_result.error_code` | string | 否 | 错误码（见 §九） |
| `task_result.cost_ms` | number | 否 | 耗时毫秒 |

---

## 六、消息格式规范（按用途分类）

### 6.1 任务分配（Task Assignment）

**下发子任务给 Agent 的可执行对象**（Scheduler → AgentRuntime，`subTask`）：

```json
{
  "task_id": "task_20260825_192549_929c640c__sub_001",
  "trace_id": "task_20260825_192549_929c640c",
  "external_task_id": "任务在 tasks/ 下的外部 ID",
  "type": "SUMMARY_TASK",
  "role": "guardian",
  "context": "任务ID: ...\n子任务: ...\n原始请求: ...\n参与模型: 克劳德\n\n=== 上游任务输出 ===\n...",
  "instruction": "综合以上结果与评审意见，汇总输出最终答案",
  "input_files": []
}
```

**分配事件**（可选显式广播，当前实现由 `collab:subtask:update` 承载前端状态）：

```
事件名:  SUB_TASK_DISPATCH_EVENT
msg_type: SUB_TASK_DISPATCH_EVENT
task_context.task_input: { user_query, task_id }
task_context.task_deps:   [上游子任务ID...]
```

### 6.2 状态上报（Status Reporting）

Agent 执行完成后的统一输出 `UnifiedOutput`（`src/adapters/claude.js` 的 `buildUnifiedOutput`）：

```json
{
  "task_id": "task_...__sub_001",
  "status": "success",
  "content": "结果正文",
  "output_files": [],
  "error": null,
  "tokens_used": 1024,
  "duration_ms": 12000
}
```

`status` 取值：`success` | `failed`；`failed` 时 `error` 为 `{ code, message }`。

Scheduler 据此组装状态事件：

```json
// 成功
{ "msg_type": "SUB_TASK_SUCCESS_EVENT", "task_result": { "output": { "content": "..." }, "cost_ms": 12000 } }

// 失败（触发重试判定）
{ "msg_type": "SUB_TASK_FAIL_EVENT",
  "task_result": { "output": {}, "error_msg": "克劳德: ...", "error_code": "ALL_AGENTS_FAILED" } }

// 重试
{ "msg_type": "SUB_TASK_RETRY_EVENT",
  "task_context": { "task_input": { "retry_count": 1 } },
  "task_result": { "error_msg": "...", "error_code": "RETRY" } }

// 超时
{ "msg_type": "SUB_TASK_TIMEOUT_EVENT",
  "task_result": { "error_msg": "任务执行超时", "error_code": "TIMEOUT" } }
```

黑板子任务状态（Scheduler 写）：

```
status ∈ PENDING | RUNNING | SUCCESS | RETRYING | TIMEOUT | FAILED | SKIPPED
```

### 6.3 结果回传（Result Return）

顶层任务完结结果回传（Scheduler → Orchestrator，Promise resolve 返回值）：

```json
{
  "trace_id": "task_20260825_192549_929c640c",
  "final_result": "最终汇总内容",
  "status": "SUCCESS"
}
```

伴随事件：

```json
{ "msg_type": "TASK_ALL_FINISH_EVENT",
  "task_result": { "output": { "final_result": "最终汇总内容" } } }
```

### 6.4 心跳（Heartbeat）

Agent 心跳由 AgentRuntime 内部维护（5s），Scheduler 同步到能力画像；跨进程心跳事件格式：

```json
{
  "msg_meta": {
    "trace_id": null,
    "sub_task_id": null,
    "msg_type": "AGENT_HEARTBEAT_EVENT",
    "sender_agent": "claude_agent_01",
    "receiver_agent": "all",
    "timestamp": 1756131600000
  },
  "task_context": {},
  "task_result": {
    "output": {
      "agent_name": "克劳德",
      "agent_instance_id": "claude_agent_01",
      "online": true,
      "busy": false,
      "current_task": null,
      "latency_ms": 230,
      "load_score": 0
    }
  }
}
```

心跳职责：离线/在线切换、忙碌状态同步、负载分。连续 3 次（15s）无心跳视为离线，Scheduler 停止向其下发，已有运行任务按超时回收。

### 6.5 终止信号（Termination Signals）

| 信号 | 触发方 | 消息 | 黑板动作 |
|------|--------|------|---------|
| 取消顶层任务 | 用户/Orchestrator | `TASK_CANCEL_EVENT` | `main.overall_status=CANCELLED`，清空所有 `running` 标记 |
| 全局失败 | Scheduler | `TASK_FINAL_FAIL_EVENT` | `main.overall_status=FAILED`，写 `fail_reason` |
| Agent 离线 | 心跳判定 | `AGENT_OFFLINE_EVENT` | 停止向其分配，运行中任务超时回收 |

**TASK_CANCEL_EVENT 消息**：

```json
{
  "msg_meta": { "msg_type": "TASK_CANCEL_EVENT", "sender_agent": "scheduler", "receiver_agent": "all", "trace_id": "..." },
  "task_context": {},
  "task_result": {}
}
```

---

## 七、事件清单与 Topic 映射

### 7.1 核心事件（`src/engine/events.js`，已实现）

| 事件常量 | Topic（事件名） | 主导方 |
|----------|----------------|--------|
| `TASK_CREATE` | `TASK_CREATE_EVENT` | Scheduler |
| `TASK_PLAN_DISPATCH` | `TASK_PLAN_DISPATCH_EVENT` | Scheduler |
| `TASK_PLAN_FINISH` | `TASK_PLAN_FINISH_EVENT` | Scheduler |
| `TASK_DEPEND_READY` | `TASK_DEPEND_READY_EVENT` | Scheduler |
| `SUB_TASK_DISPATCH` | `SUB_TASK_DISPATCH_EVENT` | Scheduler |
| `SUB_TASK_SUCCESS` | `SUB_TASK_SUCCESS_EVENT` | Scheduler |
| `SUB_TASK_FAIL` | `SUB_TASK_FAIL_EVENT` | Scheduler |
| `SUB_TASK_RETRY` | `SUB_TASK_RETRY_EVENT` | Scheduler |
| `SUB_TASK_TIMEOUT` | `SUB_TASK_TIMEOUT_EVENT` | Scheduler |
| `AGENT_OFFLINE` | `AGENT_OFFLINE_EVENT` | Scheduler |
| `TASK_FINAL_FAIL` | `TASK_FINAL_FAIL_EVENT` | Scheduler |
| `TASK_ALL_FINISH` | `TASK_ALL_FINISH_EVENT` | Scheduler |
| `TASK_CANCEL` | `TASK_CANCEL_EVENT` | Scheduler |
| `AGENT_HEARTBEAT` | `AGENT_HEARTBEAT_EVENT` | AgentRuntime/Scheduler |

### 7.2 前端协作事件（Topic 直发，非标准信封）

| Topic | 用途 |
|-------|------|
| `collab:subtask:update` | 右侧任务面板单条子任务状态刷新 |
| `collab:subtask:done` | 子任务执行完成（含各模型输出），供对话回写 |
| `collab:planned` | DAG 拆解结果，供对话展示 |
| `agent:stream:start/chunk/end` | 流式输出 |
| `task:created/assessed/executing/updated/completed/failed` | 任务生命周期通知 |

### 7.3 Skill 事件（DeepResearch）

| 事件常量 | Topic |
|----------|-------|
| `DEEP_RESEARCH_START` | `SKILL_DEEP_RESEARCH_START_EVENT` |
| `RESEARCH_DIMENSION_READY` | `RESEARCH_DIMENSION_READY_EVENT` |
| `MULTI_RESEARCH_ALL_FINISH` | `MULTI_RESEARCH_ALL_FINISH_EVENT` |
| `RESEARCH_DRAFT_FINISH` | `RESEARCH_DRAFT_FINISH_EVENT` |
| `REVIEW_RESULT_FINISH` | `REVIEW_RESULT_FINISH_EVENT` |
| `DEEP_RESEARCH_COMPLETE` | `SKILL_DEEP_RESEARCH_COMPLETE_EVENT` |

---

## 八、黑板 Key 规范与读写权限

| Key | 内容 | 写权限 |
|-----|------|--------|
| `blackboard:task:{trace_id}:main` | 顶层任务状态 Hash | Scheduler |
| `blackboard:task:{trace_id}:sub:{sub_id}` | 子任务状态 Hash | Scheduler |
| `blackboard:snapshot:{trace_id}` | 上下文快照 | Scheduler/Skill |
| `blackboard:idempotent:{msg_id}` | 幂等去重 | Blackboard API |
| `blackboard:running:{sub_id}` | 运行中 TTL 标记（僵尸检测） | Scheduler |
| `blackboard:agent:profile:{agent_id}` | 能力画像 Hash | Scheduler |

**子任务 Hash 字段**：`sub_task_id / trace_id / agent_id / agents / status / deps / input / output / outputs / error_msg / retry_count / max_retry / start_time / end_time / timeout_ms / role / preferred_agent`。

---

## 九、错误码约定

| 错误码 | 含义 | 处理 |
|--------|------|------|
| `ALL_AGENTS_FAILED` | 子任务所有分配 Agent 均失败 | 触发重试判定 |
| `TIMEOUT` | 模型调用超时 | 重试，超 3 次判失败 |
| `AUTH_REQUIRED` | 模型未登录/认证失败 | 重试，仍失败判失败 |
| `EMPTY_RESPONSE` | 模型返回空内容 | 重试 |
| `EXECUTION_ERROR` | 适配器执行异常 | 重试 |
| `RETRY` | 普通重试占位码 | 指数退避重试 |
| `SUB_TASK_FAILED` | 存在子任务最终失败 | 顶层任务判失败 |

---

## 十、与现有实现映射与待补齐

**已实现**：统一信封 `buildMessage()`、幂等 `isDuplicate()`、状态/任务类型枚举、
心跳（进程内）、取消/全局失败、协作日志、流式协议。

**待补齐（建议）**
1. `AGENT_HEARTBEAT_EVENT` / `AGENT_OFFLINE_EVENT` 目前进程内 `setInterval` 维护，
   未通过总线广播为独立 Topic；跨进程部署时需落成标准信封事件。
2. `SUB_TASK_DISPATCH_EVENT` / `TASK_DEPEND_READY_EVENT` 常量已定义，但调度闭环
   主要走函数直调；如需外部观测，可在 `_dispatchSubTask` 内补 `emit`。
3. `TASK_PLAN_DISPATCH_EVENT` 已定义未订阅，规划下发建议补事件驱动闭环。
4. 人工干预（终止/重试/跳过子任务）目前 `TASK_CANCEL` 可用，`SKIP` 无独立事件。
