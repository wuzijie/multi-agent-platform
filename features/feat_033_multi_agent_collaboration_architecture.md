# 多智能体协同整体架构设计方案

> 关联调研：上游子任务「多智能体协同模式简要分析」（编排器 / 去中心化 / 黑板 / 事件驱动 / 分层角色 / 管道 / 市场 七大模式对比）
> 关联实现：`src/orchestrator/orchestrator.js`、`src/engine/scheduler.js`、`src/engine/events.js`、
> `src/blackboard/blackboard.js`、`src/eventbus/bus.js`、`src/agent/runtime.js`
> 结论落点：采用 **编排器（Orchestrator）+ 事件总线（Event Bus）+ 黑板（Blackboard）+ 统一调度器（Scheduler）** 的混合架构，
> 兼顾「可控性、扩展性、信息共享、容错性」，与上游调研推荐一致。

---

## 0. 设计目标与原则

| 目标 | 设计原则 | 落点 |
|------|----------|------|
| 可控 | 任务拆解、调度、状态变更**集中决策** | Orchestrator + Scheduler 双层编排 |
| 解耦 | 模块间只通过**事件与黑板**通信，不直接调用 | Event Bus + Blackboard |
| 共享 | 中间结果与全局状态**统一可见**，支持机会主义复用 | Blackboard 分层 Key |
| 容错 | 单点失败可重试/换人/熔断，超时可回收 | Scheduler 容错策略 |
| 可观测 | 全链路事件与协作日志落盘，可复盘 | `logs/events/` + `logs/collab/` |
| 可扩展 | 新增 Agent/Skill/模式走配置与协议，不改核心调度器 | 能力画像 + 事件协议 + 工具注册 |

---

## 1. 总体架构（分层视图）

```
┌──────────────────────────────────────────────────────────────────────┐
│                           用户交互层                                  │
│   Web 前端  ──  REST API / WebSocket（src/api/server.js）             │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     编排层 Orchestrator（任务门面）                   │
│  src/orchestrator/orchestrator.js                                    │
│  - 任务创建 / 复杂度判别 / 模式路由                                   │
│  - 对话记录唯一写入 + 流式事件回写                                    │
│  模式路由：单Agent │ @mention 转交 │ @多Agent 讨论 │ event-driven │ skill │
└───────────────┬──────────────────────┬──────────────────────┬─────────┘
                │                      │                      │
                ▼                      ▼                      ▼
┌─────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐
│  Skill 层           │  │  统一调度器 Scheduler │  │  Agent 运行时       │
│  src/skills/        │  │  src/engine/         │  │  src/agent/        │
│  deep-research 等   │  │  scheduler.js        │  │  runtime.js        │
│  (标准化技能闭环)    │  │  DAG/分发/重试/超时/  │  │  生命周期/心跳/调用  │
│                     │  │  心跳/汇总/裁决       │  │  工具循环(伪FC)     │
└─────────┬───────────┘  └──────────┬───────────┘  └─────────┬──────────┘
          │                         │                        │
          │       ┌─────────────────▼─────────────┐          │
          └──────►│      黑板 Blackboard           │◄─────────┘
                  │   src/blackboard/（文件版Redis）│
                  │   状态持久化 + TTL + 幂等        │
                  └─────────────────┬─────────────┘
                                    │
                  ┌─────────────────▼─────────────┐
                  │      事件总线 Event Bus        │
                  │   src/eventbus/bus.js         │
                  │   EventEmitter + 文件持久化    │
                  └─────────────────┬─────────────┘
                                    │
                  ┌─────────────────▼─────────────┐
                  │      模型适配器 Adapters       │
                  │   claude / kimi / deepseek /  │
                  │   qwen（CLI + 直连SSE）        │
                  └───────────────────────────────┘
```

**分层职责铁律**
1. **Orchestrator 是门面，不是状态决策者**：它负责入口、路由、对话与流式回写，不直接改写子任务状态。
2. **Scheduler 是唯一状态决策者**：所有子任务状态（PENDING/RUNNING/SUCCESS/FAILED…）只能由调度器写黑板，Agent 只读不写。
3. **通信走事件、共享走黑板**：模块间禁止直接互相持有引用调用业务方法；跨模块协作一律 `eventBus.emit()` + 黑板读写。
4. **模型是资源，不是控制器**：Agent 只能被分发执行子任务，不能反向调度或修改其它 Agent 状态。

---

## 2. 角色分工

### 2.1 系统组件角色（常驻代码模块）

| 组件 | 角色定位 | 核心职责 | 明确不做 |
|------|----------|----------|----------|
| **Orchestrator** 编排器 | 任务门面 / 会话管理器 | 任务创建、复杂度判别、模式路由、对话唯一写入、流式事件回写、`@` 转交解析 | 不直接改子任务状态、不维护 DAG |
| **Scheduler** 统一调度器 | 唯一状态决策者 / 工作流引擎 | DAG 生成与校验、依赖就绪判定、能力画像匹配、任务分发、重试/超时/熔断、汇总裁决 | 不调用具体模型适配器（经 executor 注入） |
| **AgentRuntime** 运行时 | Agent 生命周期管理器 | Agent 注册、心跳、在线/忙碌状态、调用适配器、工具循环 | 不做任务拆解与状态决策 |
| **EventBus** 事件总线 | 消息通道 | Topic 订阅/发布、事件持久化、`*` 通配广播 | 不承载业务逻辑 |
| **Blackboard** 黑板 | 共享内存 / 状态仓库 | 分层 Key 读写、TTL 惰性过期、幂等去重、快照 | 不参与调度决策 |
| **Skill 层** | 标准化技能闭环 | 把「深度调研」等复杂流程封装为标准事件闭环，供任意 Agent 复用 | 不反向控制平台任务状态 |
| **ToolRegistry** 工具层 | 模型可调用工具 | 工具 schema 注入、`[TOOL_CALL]` 解析、工具执行 | 不做任务编排 |
| **Model Adapters** 适配器 | 异构模型统一接口 | CLI/SSE 调用、流式输出捕获、健康检查、错误归一化 | 不做协作逻辑 |

### 2.2 Agent 协作角色（模型在子任务中临时扮演的身份）

角色不是常驻身份，而是**某个子任务执行时的临时职责**，由子任务类型决定：

| 协作角色 | 对应任务类型 | 职责 | 典型产出 |
|----------|--------------|------|----------|
| **Planner 规划者** | `PLAN_TASK` | 把用户请求拆解为 2–5 个子任务 DAG，并指定执行模型 | DAG（JSON 数组） |
| **Executor 执行者** | `CODE_TASK` / `DEBUG_TASK` / `RESEARCH_TASK` | 完成主体产出 | 代码 / 方案 / 调研素材 |
| **Reviewer 评审者** | `REVIEW_TASK` | 从自身专长角度评审上游产出，给结论与意见 | 「结论：可行/需修改」+ 意见 + 补充 |
| **Guardian/Summarizer 汇总者** | `SUMMARY_TASK` / `FINAL_TASK` | 综合上游结果与评审意见，输出最终答案 | 终稿 / 汇总报告 |

### 2.3 模型能力画像与角色映射

| 模型 | 能力标签 | 擅长任务类型 | 协作定位 |
|------|----------|--------------|----------|
| 克劳德 Claude | logic / complex_code / architecture / text_refinement | PLAN / REVIEW / CODE | 默认主 Agent，拆解规划、架构、规范、兜底裁决 |
| 吉米 Kimi | long_text / information_extraction / documentation | SUMMARY / REVIEW / RESEARCH | 长文本、信息提炼、文档 |
| 迪普斯克 DeepSeek | algorithm / performance / bug_detection / deep_tech | CODE / DEBUG / REVIEW | 算法、纠错、技术深度 |
| 钱文 Qwen | lightweight_dev / fast_iteration / scenario_fitting / chinese_optimization | CODE / REVIEW / SUMMARY | 快速开发、中文优化、场景适配 |

> 通用兜底：所有模型默认都具备 REVIEW / SUMMARY 能力，避免画像冷启动导致无模型可用。

---

## 3. 通信与消息机制

### 3.1 通信主干：事件总线 + 黑板

- **控制流 / 通知** → 事件总线（`src/eventbus/bus.js`），事件名即 Topic，支持 `on(type)` 与 `on('*')` 通配。
- **数据流 / 状态** → 黑板（`src/blackboard/blackboard.js`），分层 Key 承载任务、子任务、画像、快照。
- **模型间语义通信** → 通过**上游子任务输出注入下游上下文**实现（见 3.5），不依赖模型自行点对点消息。

### 3.2 标准消息体（`buildMessage`）

统一信封三部分，任何跨模块事件都携带该结构：

```
{
  msg_meta:      { trace_id, sub_task_id, msg_id, msg_type, sender_agent,
                   receiver_agent, timestamp, timeout_ms, retry_times, max_retry },
  task_context:  { task_input, task_deps, context_snapshot_key },
  task_result:   { output, error_msg, error_code, cost_ms }
}
```

### 3.3 事件清单与分类

| 类别 | 事件（Topic） | 方向 |
|------|---------------|------|
| 调度驱动 | `TASK_CREATE_EVENT`、`TASK_PLAN_DISPATCH_EVENT`、`TASK_PLAN_FINISH_EVENT`、`TASK_DEPEND_READY_EVENT`、`SUB_TASK_DISPATCH_EVENT` | Scheduler 主导 |
| 执行回调 | `SUB_TASK_SUCCESS_EVENT`、`SUB_TASK_FAIL_EVENT` | 执行方发出，Scheduler 消费 |
| 容错 | `SUB_TASK_RETRY_EVENT`、`SUB_TASK_TIMEOUT_EVENT`、`AGENT_OFFLINE_EVENT`、`TASK_FINAL_FAIL_EVENT` | Scheduler 主导 |
| 收尾 | `TASK_ALL_FINISH_EVENT`、`TASK_CANCEL_EVENT` | Scheduler 主导 |
| 运维 | `AGENT_HEARTBEAT_EVENT` | AgentRuntime 定时 |
| Skill 闭环 | `SKILL_DEEP_RESEARCH_START_EVENT`、`RESEARCH_DIMENSION_READY_EVENT`、`MULTI_RESEARCH_ALL_FINISH_EVENT`、`RESEARCH_DRAFT_FINISH_EVENT`、`REVIEW_RESULT_FINISH_EVENT`、`SKILL_DEEP_RESEARCH_COMPLETE_EVENT` | Skill 层 |
| 前端流式 | `agent:stream:start` / `agent:stream:chunk` / `agent:stream:end`（附 `stream_id`） | Orchestrator → UI |
| 前端面板 | `task:*`、`collab:planned`、`collab:subtask:update`、`collab:subtask:done` | 各层 → UI |

### 3.4 幂等、顺序与死信

- **幂等**：每条消息携带 `msg_id`，消费前置 `blackboard.checkAndSetIdempotent(msg_id, ttl)`，重复消息直接跳过。
- **顺序**：单任务内依赖顺序由 **DAG 依赖就绪** 保证，而非依赖消息队列顺序；无依赖子任务可并发。
- **迟到回调**：子任务已超时/已非 `RUNNING` 时，迟到回调被忽略（`_onSubTaskFinish` 前置状态校验）。
- **死信**：重试耗尽（> `max_retry`）或致命错误（FATAL）直接置 `FAILED`，不无限重试。

### 3.5 模型间语义通信

1. **上游输出注入**：子任务下发时，把其**直接依赖**（上游 SUCCESS 子任务）的输出注入 `context`，下游模型据此参考上游成果（单条截断 8000 字符，防上下文爆炸）。
2. **`@Agent名` 转交**：单 Agent 模式下模型回复含「@吉米 问题」时，Orchestrator 提取并转交，最多 3 跳防死循环。
3. **讨论模式消息流**：回答者 A → 评审者 B/C → A 修订 → 判定，形成结构化评审闭环。

---

## 4. 任务分配与调度

### 4.1 任务生命周期（顶层状态机）

```
created → assessing → executing ──┬──> completed
                                  └──> suspended（人工介入） / failed
（事件驱动协作内部独立运行 Scheduler 状态机：PENDING→RUNNING→SUCCESS/FAILED/CANCELLED）
```

### 4.2 调度闭环（事件驱动，无轮询）

```
TASK_CREATE_EVENT → 规划(DAG) → 写黑板 → 依赖就绪判定
  → 能力画像匹配 → 下发 SUB_TASK_DISPATCH → 执行 → 回调
  → SUB_TASK_SUCCESS/FAIL → 状态更新 → 再判依赖就绪 → … → TASK_ALL_FINISH_EVENT
```

### 4.3 DAG 拆解

- **LLM 规划**：主 Agent（克劳德）把请求拆为 2–5 个子任务 JSON（含 `type` / `instruction` / `deps` / `agent`），首个子任务无依赖。
- **默认回退**：LLM 输出无法解析/调用失败时回退内置标准 DAG `规划 → 执行 → 评审 → 汇总`。
- **依赖语义**：子任务「所有依赖 = SUCCESS」才就绪；依赖节点不存在视为满足（防 DAG 卡死）。

### 4.4 能力画像匹配

匹配优先级（`_matchAgents`）：
1. **精准匹配**：`support_task_types` 包含子任务类型；
2. **负载优先**：按 `load_score` 升序；
3. **轮转**：按轮转起始偏移取 Agent，避免总是同一模型；
4. **兜底**：无精准匹配则全量在线池；无空闲则延迟重试；全员熔断则快速失败。

主 Agent 在拆解时指定的 `preferred_agent` 优先，但**熔断/离线时自动降级**到画像匹配。

### 4.5 分发执行

- 每个子任务分配 **1 个** Agent（`agentsPerTask=1`）；预留多 Agent 同子任务并行能力（`Promise.allSettled`）。
- 执行单元 `subTask` 注入 `trace_id`、`external_task_id`、`type`、`role`、`context`（含上游输出）、`instruction`。
- 协作子任务设 `disableTools=true`，禁止模型在子任务内再触发 deep_research 等工具形成嵌套。

---

## 5. 状态同步

### 5.1 黑板 Key 规范

| Key | 类型 | 内容 |
|-----|------|------|
| `blackboard:task:{trace_id}:main` | Hash | 顶层任务：user_query / overall_status / dag_info / final_result / fail_reason / executor_agent… |
| `blackboard:task:{trace_id}:sub:{sub_id}` | Hash | 子任务：sub_task_id / status / deps / input / output / retry_count / agents… |
| `blackboard:snapshot:{trace_id}` | String | 上下文快照 |
| `blackboard:idempotent:{msg_id}` | Set | 幂等去重（TTL=任务超时） |
| `blackboard:running:{sub_id}` | KV | 运行中标记（TTL=超时，用于僵尸检测） |
| `blackboard:agent:profile:{agent_id}` | Hash | Agent 能力画像 |

### 5.2 唯一写者原则

- **子任务状态只由 Scheduler 写**，Agent 只读全局状态、只回传自身输出，杜绝多写者冲突。
- Orchestrator 只写**平台层任务对象**（`tasks/{task_id}/task.json`）与**对话**（`conversation.md`），与 Scheduler 的黑板状态解耦。

### 5.3 状态同步链路

- **画像同步**：Scheduler 每 5s 心跳读取 `AgentRuntime.getAgentStates()`，把在线/忙碌/延迟同步到画像。
- **前端同步**：`collab:subtask:update` 携带外部 `task_id` 推送到右侧任务面板；`collab:subtask:done` 回写对话。
- **状态持久化**：黑板文件带 `expires_at` 惰性过期；事件总线写 `logs/events/` 留痕。

### 5.4 快照与恢复

- 运行前写 `running` 标记（TTL），超时自动视为僵尸回收。
- `blackboard:snapshot:{trace_id}` 保留关键上下文，便于人工复盘或重放。

---

## 6. 冲突解决

### 6.1 评审冲突裁决（多模型意见收敛）

| 情形 | 裁决策略 |
|------|----------|
| 多数通过（≥2 pass） | 接受产出 |
| 多数驳回（≥2 reject） | 退回重做，附驳回意见 |
| 多数建议修改（≥2 revise） | 进入迭代修正，附修改指引 |
| 票数分散（1:1 / 1:1:1） | **克劳德** 优先裁决；无克劳德则取首条评审意见，默认「需修改」（更稳妥） |

### 6.2 多模型输出合并

- **评审/汇总类**（REVIEW / SUMMARY）：多模型输出**拼接合并**（`**模型名**\n内容`），保留多视角，不覆盖。
- **执行类**（CODE / DEBUG）：取**第一个成功**模型输出为主结果，避免多份执行产出互相冲突。

### 6.3 状态冲突

- **迟到回调 vs 已超时**：子任务非 `RUNNING` 时忽略迟到回调（幂等 + 状态前置校验）。
- **重复消息**：`msg_id` 幂等去重，只处理一次。
- **Agent 忙碌冲突**：画像 `status=busy` 时不被分配；心跳与执行完释放保证一致。

### 6.4 依赖冲突

- 依赖节点缺失 → 视为满足（防 DAG 卡死）；依赖失败 → 下游不触发，走全局失败判定。

---

## 7. 容错策略

| 策略 | 机制 | 说明 |
|------|------|------|
| **重试** | 指数退避 `[0,1s,3s,5s,10s]`，最多 `max_retry=3` | 失败子任务自动重试并换 Agent |
| **超时回收** | 每个子任务 `timeout_ms`（默认 300s）+ `running` 标记 | 超时置 TIMEOUT 并重调度，超 3 次失败 |
| **熔断** | 致命错误（402/鉴权/Invalid role）`markAgentFatal` | 熔断模型不再派发，避免白烧 token；全员熔断快速失败 |
| **降级回退** | Agent 离线/未配置 → 回退克劳德；LLM 规划失败 → 回退默认 DAG | 保证流程不因单点僵死 |
| **失败终止** | 任一子任务重试耗尽 → 顶层 FAILED，输出 `fail_reason` | 全局快速失败 |
| **人工介入** | 复杂任务多轮评审不通过 → `suspended` + `suspend_reason` | 保留人工兜底 |
| **幂等** | `msg_id` + `checkAndSetIdempotent` | 防重复消费副作用 |
| **心跳自愈** | 5s 心跳同步在线状态，忙碌释放 | 空闲 Agent 自动恢复调度 |

---

## 8. 架构设计要点（总结）

1. **混合架构 = 可控 + 弹性 + 共享**：编排器保证流程可控、事件总线保证解耦与异步、黑板保证信息共享，三者叠加避免单一模式缺陷。
2. **双层编排**：Orchestrator 管「用户会话与模式路由」，Scheduler 管「子任务状态机与工作流」，职责分离避免编排器成单点。
3. **唯一写者**：状态变更集中到 Scheduler，天然规避并发写冲突与不一致。
4. **DAG + 事件驱动 = 无轮询**：依赖就绪即调度，天然支持并行子任务与依赖表达。
5. **能力画像 + 轮转 = 合理分工**：任务类型精准匹配 + 负载均衡 + 避免马太效应。
6. **容错分层**：可重试错误→指数退避；不可恢复错误→熔断；超时→僵尸回收；规划/Agent 失败→降级回退。
7. **冲突裁决有兜底**：多数决 + 克劳德仲裁 + 默认「需修改」，保证评审闭环能收敛。
8. **可观测**：事件落盘 + 协作日志 + 黑板快照，全链路可复盘。
9. **演进路径清晰**：文件黑板可替换为 Redis、EventEmitter 可替换为真实 MQ、单进程可拆多进程，协议与 Key 规范不变即可平滑升级。

---

## 9. 关键权衡与边界

- **编排器单点**：当前单进程内可接受；跨进程需将 Scheduler 状态外置（Redis）并加主备。
- **黑板为文件实现**：适合本地单机；高并发多写场景需迁移 Redis（Key 语义保持一致）。
- **1 Agent / 子任务为主**：控制成本与复杂度；多 Agent 同子任务并行仅用于评审/调研等「多视角」场景。
- **模型规划不确定性**：LLM 拆解 DAG 可能不稳定，已用「默认 DAG 回退 + 解析校验」兜底。
