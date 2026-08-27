# 多 Agent 协同工作方案（落地版）

> 关联方案：
> - `features/feat_028_multi_agent_collaboration_plan.md`（总体目标与协同模式）
> - `features/feat_029_agent_roles_comm_protocol.md`（角色与通信协议）
> - 上游子任务 `task_20260825_192549_929c640c__sub_002`（任务拆解与调度机制）
>
> 本文将上述设计整合为一份可直接落地的完整工作方案，覆盖目标、架构、角色、协议、调度、容错与实施步骤。

---

## 一、目标

1. **任务可拆分**：把复杂用户请求拆分为可并行/串行执行的子任务 DAG，按 Agent 能力画像自动分发到最合适模型。
2. **质量可闭环**：通过「执行 → 评审 → 裁决 → 修正 → 汇总」的角色闭环，降低单模型偏见与错误率。
3. **状态可观测**：全链路事件落盘（`logs/events/` + `logs/collab/`），子任务状态写入黑板，支持实时面板与事后复盘。
4. **运行可容错**：单点失败可重试、可换模型重分配；超时任务自动回收，避免悬挂阻塞整体流程。
5. **扩展低成本**：新增 Agent、Skill、协同模式均通过配置与事件协议接入，不侵入核心调度器。

---

## 二、总体架构

### 2.1 系统组成

```
┌─────────────────────────────────────────────────────────────────────┐
│                            用户交互层                                │
│  Web 前端 (frontend/index.html)  ─  REST API / WebSocket (src/api)   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          任务编排层 (Orchestrator)                   │
│  src/orchestrator/orchestrator.js                                   │
│  - 任务创建 / 复杂度判别                                             │
│  - 模式路由：单 Agent / 多 Agent 讨论 / 事件驱动 / Skill             │
│  - 对话记录唯一写入 + 流式事件回写                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐        ┌──────────────────┐        ┌─────────────────┐
│   Skill 层     │        │   统一调度器      │        │   Agent 运行时   │
│ src/skills/   │◄──────►│ src/engine/      │◄──────►│ src/agent/      │
│ deep-research │        │ scheduler.js     │        │ runtime.js      │
│ (标准化技能)   │        │ (DAG/分发/重试/   │        │ (调用各模型适配器)│
└───────────────┘        │  超时/心跳/汇总)  │        └─────────────────┘
                         └──────────────────┘                 │
                                    │                          │
                                    ▼                          ▼
                         ┌──────────────────┐        ┌─────────────────┐
                         │   黑板 (Blackboard)│        │   模型适配器     │
                         │ src/blackboard/  │        │ src/adapters/   │
                         │ 文件版 Redis 模拟 │        │ claude/kimi/    │
                         │ 状态持久化 + TTL │        │ deepseek/qwen   │
                         └──────────────────┘        └─────────────────┘
                                    │
                                    ▼
                         ┌──────────────────┐
                         │   事件总线        │
                         │ src/eventbus/    │
                         │ File Event Bus   │
                         │ 内存通知 + 文件持久│
                         └──────────────────┘
```

### 2.2 核心数据流

```
用户请求
  → Orchestrator 模式路由
    ├─ 简单/单 Agent          → AgentRuntime 直接执行
    ├─ @mention 单 Agent      → AgentRuntime + @提取与转交
    ├─ @多 Agent 讨论         → 讨论模式闭环
    ├─ skill=deep_research    → DeepResearch 5 步事件闭环
    └─ collab_mode=event-driven → Scheduler DAG 事件驱动闭环

事件驱动闭环：
  TASK_CREATE_EVENT → 生成/校验 DAG
  → 批量写入子任务 (PENDING)
  → 依赖就绪检测
  → 能力画像匹配 Agent
  → SUB_TASK_DISPATCH (RUNNING)
  → Agent 流式执行
  → SUB_TASK_SUCCESS / FAIL
  → 更新黑板 / 触发下一轮就绪
  → TASK_ALL_FINISH → 汇总 → 写入对话
```

---

## 三、角色与职责

### 3.1 系统组件角色

| 组件 | 核心职责 | 明确不做 |
|------|---------|---------|
| **Orchestrator** | 任务生命周期入口、复杂度判别、模式路由、对话记录唯一写入、流式回写、@转交 3 跳防循环 | 不直接决定子任务状态；不维护 DAG |
| **Scheduler** | 唯一状态决策者；DAG 生成/解析/依赖就绪检测；能力匹配 + 轮转 + 负载；重试/超时/幂等；上游输出注入；最终汇总 | 不直接调 CLI；不写对话记录；不处理前端 WS |
| **Agent Runtime** | 四 Agent 注册/生命周期、5s 心跳健康检查、按名执行并回退克劳德 | 不拆任务、不写黑板、不汇总 |
| **Blackboard** | 文件版 Redis 模拟：KV/Hash + TTL、幂等键、运行中标记 | 不感知业务状态机 |
| **Event Bus** | 内存 EventEmitter + `logs/events/` 文件持久化、Topic 即事件名 | 不做业务路由、不做消息重放 |

### 3.2 Agent 协作角色

| 角色 | 职责 | 边界 |
|------|------|------|
| **planner 规划者** | 拆解用户请求为 DAG、指定执行模型 | 只产出计划，不写代码 |
| **executor 执行者** | 完成具体子任务并产出结果 | 按指令执行，不评判他人 |
| **reviewer 评审者** | 评审产出，输出「可行/需修改」+ 意见 | 只评审，不直接修改答案 |
| **guardian/summarizer 汇总者** | 综合上游产出与评审，产出最终答案，确保不偏离原始目标 | 不新增未经验证的事实 |
| **arbiter 裁决者** | 评审意见冲突时裁决（少数服从多数，均等时克劳德裁决） | 仅在讨论/复杂任务闭环中出现 |

### 3.3 四模型能力边界

| 模型 | 默认主角色 | 能力标签 | 建议承担 | 建议回避 |
|------|-----------|---------|---------|---------|
| **克劳德 Claude** | planner / guardian | logic、complex_code、architecture、text_refinement | 复杂架构、规划拆解、代码规范、最终汇总 | 高频简单任务的低延迟执行 |
| **吉米 Kimi** | reviewer / summarizer | long_text、information_extraction、documentation | 长文档分析、信息提炼、文档生成 | 复杂算法优化 |
| **迪普斯克 DeepSeek** | executor（代码） | algorithm、performance、bug_detection、deep_tech | 算法实现、调试纠错、性能优化、漏洞排查 | 通用文本创作 |
| **钱文 Qwen** | executor（快速迭代） | lightweight_dev、fast_iteration、scenario_fitting、chinese_optimization | 快速开发、场景适配、中文表达优化 | 超复杂架构设计 |

**边界约定**：
1. 能力画像来自 `config/agents.yaml`，是「建议」而非「强制」；离线时调度器回退到其他在线模型。
2. `preferred_agent` 优先于能力画像匹配；指定 Agent 不在线则回退画像匹配。
3. 一个子任务当前只分配一个 Agent（`agentsPerTask = 1`），`agents[]` 预留多 Agent 同子任务的扩展位。

---

## 四、通信协议

### 4.1 通信通道

| 通道 | 载体 | 用途 | 写入方 |
|------|------|------|--------|
| 事件总线 | `src/eventbus/bus.js` + `logs/events/` | 任务分配、状态上报、心跳、终止、流式输出 | 所有组件 |
| 黑板 | `src/blackboard/blackboard.js` | 共享状态、幂等、运行中标记、能力画像 | Scheduler（业务状态）、Blackboard API |
| 对话记录 | `tasks/{task_id}/conversation.md` | 面向用户的最终呈现 | Orchestrator |
| 协作日志 | `logs/collab/*.log` | 模型间消息传递追踪 | CollabLogger |

**通信规则**：
- **单写者原则**：`blackboard:task:*` 业务状态仅 Scheduler 写入；Agent/Orchestrator 只读。
- **事件即事实**：状态变更必须通过事件广播，黑板仅是事件的持久化投影。
- **幂等**：所有事件带 `msg_id`，消费者先 `isDuplicate()` 再处理。
- **有向路由**：`sender_agent → receiver_agent`；`receiver_agent = 'all'` 表示广播。

### 4.2 统一消息信封

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

### 4.3 关键消息类型

| 用途 | 事件名 | 关键字段 |
|------|--------|---------|
| 任务创建 | `TASK_CREATE_EVENT` | `task_input.user_query` |
| 规划下发 | `TASK_PLAN_DISPATCH_EVENT` | DAG 描述 |
| 规划完成 | `TASK_PLAN_FINISH_EVENT` | 规划结果 |
| 依赖就绪 | `TASK_DEPEND_READY_EVENT` | 就绪子任务列表 |
| 子任务下发 | `SUB_TASK_DISPATCH_EVENT` | `task_id`, `role`, `instruction` |
| 子任务成功 | `SUB_TASK_SUCCESS_EVENT` | `output.content` |
| 子任务失败 | `SUB_TASK_FAIL_EVENT` | `error_msg`, `error_code` |
| 子任务重试 | `SUB_TASK_RETRY_EVENT` | `retry_times` |
| 子任务超时 | `SUB_TASK_TIMEOUT_EVENT` | `error_code=TIMEOUT` |
| Agent 心跳 | `AGENT_HEARTBEAT_EVENT` | `online`, `busy`, `latency_ms` |
| Agent 离线 | `AGENT_OFFLINE_EVENT` | `agent_instance_id` |
| 任务取消 | `TASK_CANCEL_EVENT` | `trace_id` |
| 全局失败 | `TASK_FINAL_FAIL_EVENT` | `fail_reason` |
| 全部完成 | `TASK_ALL_FINISH_EVENT` | `final_result` |

前端协作 Topic（直发，非标准信封）：`collab:subtask:update`、`collab:subtask:done`、`collab:planned`、`agent:stream:start/chunk/end`、`task:created/assessed/executing/updated/completed/failed`。

---

## 五、调度机制

### 5.1 DAG 构建

Scheduler 收到任务后，按以下优先级生成 DAG：

1. **主 Agent 规划 DAG**：由 planner 角色模型输出符合规范的 DAG JSON。
2. **默认 DAG 模板**：按任务类型匹配内置模板（如代码任务、调研任务）。
3. **校验与规范化**：
   - 所有依赖必须存在于 DAG 中；
   - 拓扑排序检测环路，有环则报错；
   - 自动计算入口点（无依赖子任务）；
   - 补充 `maxParallel`、`timeout`、`maxRetries`、`priority` 等默认值。

DAG 数据结构示例：

```javascript
{
  taskId: "task_xxx",
  dagId: "dag_xxx",
  subtasks: {
    "sub_1": {
      id: "sub_1",
      name: "生成接口定义",
      agent: "claude",
      skill: "codegen",
      deps: [],
      input: { /* 子任务输入 */ },
      timeout: 240000,
      maxRetries: 3,
      priority: 5
    },
    "sub_2": {
      id: "sub_2",
      name: "实现 REST API",
      agent: "deepseek",
      deps: ["sub_1"]
    },
    "sub_3": {
      id: "sub_3",
      name: "编写单元测试",
      agent: "qwen",
      deps: ["sub_2"]
    },
    "sub_4": {
      id: "sub_4",
      name: "审查并汇总",
      agent: "claude",
      role: "guardian",
      deps: ["sub_2", "sub_3"]
    }
  },
  entryPoints: ["sub_1"],
  maxParallel: 3
}
```

### 5.2 依赖就绪与上游输出注入

每次子任务状态变更后，Scheduler 重新检测就绪子任务：

```javascript
function getReadySubtasks(taskId, dag) {
  const ready = [];
  for (const subId of Object.keys(dag.subtasks)) {
    const state = blackboard.get(`blackboard:task:${taskId}:sub:${subId}`);
    if (state.status !== "PENDING") continue;

    const sub = dag.subtasks[subId];
    const depsDone = sub.deps.every((depId) => {
      const depState = blackboard.get(`blackboard:task:${taskId}:sub:${depId}`);
      return depState.status === "SUCCESS";
    });

    if (depsDone) ready.push(subId);
  }
  return ready;
}
```

下游子任务执行前，自动将所有依赖子任务的输出合并到 `input.dependencies` 中，单上游输出上限 8000 字符，超长自动截断或摘要。

### 5.3 并发控制

Scheduler 使用信号量控制同时运行的最大子任务数（默认 `maxParallel = 3`）：

```javascript
class ConcurrencyLimiter {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.waitingQueue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return () => this.release();
    }
    return new Promise((resolve) => this.waitingQueue.push(resolve));
  }

  release() {
    this.current--;
    const next = this.waitingQueue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}
```

调度循环流程：

1. `TASK_CREATE` 触发 `buildDag()`；
2. 入口子任务写入黑板 `PENDING`；
3. 首次就绪检测，按优先级排序后尝试获取信号量；
4. 获取成功后通过 CAS 标记 `RUNNING`，下发 Agent；
5. Agent 返回 `SUCCESS/FAIL` 后释放信号量，触发下一轮就绪检测；
6. 全部子任务到达终态后触发 `TASK_ALL_FINISH`，执行汇总。

---

## 六、容错机制

### 6.1 失败重试

- **默认策略**：最大重试次数 `maxRetries = 3`，指数退避（2s / 4s / 8s，上限 30s）。
- **触发条件**：Agent 执行失败、超时、返回格式非法、适配器异常。
- **换模型重试**：首次按 `preferred_agent` 或能力画像匹配；失败后回退其他在线模型，最终回退克劳德。
- **状态流转**：`RUNNING → RETRYING → RUNNING`，超过最大重试次数后 `→ FAILED`。

### 6.2 超时处理

- **执行超时**：默认 240s，子任务级 `timeout` 可覆盖。
- **僵尸检测**：子任务下发时写入 `blackboard:running:{sub_id}` TTL 标记，超时未清理则自动回收并重排。
- **心跳超时**：AgentRuntime 5s 一次心跳，连续 3 次（15s）无心跳视为离线，Scheduler 停止向其下发，运行中任务按超时回收。

### 6.3 取消与全局失败

| 信号 | 触发方 | 事件 | 处理动作 |
|------|--------|------|---------|
| 取消顶层任务 | 用户/Orchestrator | `TASK_CANCEL_EVENT` | 所有子任务状态置 `CANCELLED`，清空 `running` 标记 |
| 全局失败 | Scheduler | `TASK_FINAL_FAIL_EVENT` | 顶层状态 `FAILED`，写 `fail_reason` |
| Agent 离线 | 心跳判定 | `AGENT_OFFLINE_EVENT` | 停止分配，运行中任务按超时回收 |

### 6.4 错误码约定

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

## 七、黑板 Key 规范

| Key | 内容 | 写权限 |
|-----|------|--------|
| `blackboard:task:{trace_id}:main` | 顶层任务状态 Hash | Scheduler |
| `blackboard:task:{trace_id}:sub:{sub_id}` | 子任务状态 Hash | Scheduler |
| `blackboard:task:{trace_id}:dag` | DAG 定义 | Scheduler |
| `blackboard:snapshot:{trace_id}` | 上下文快照 | Scheduler/Skill |
| `blackboard:idempotent:{msg_id}` | 幂等去重 | Blackboard API |
| `blackboard:running:{sub_id}` | 运行中 TTL 标记（僵尸检测） | Scheduler |
| `blackboard:agent:profile:{agent_id}` | 能力画像 Hash | Scheduler |

子任务 Hash 字段：`sub_task_id / trace_id / agent_id / agents / status / deps / input / output / outputs / error_msg / retry_count / max_retry / start_time / end_time / timeout_ms / role / preferred_agent`。

---

## 八、实施步骤

### 阶段 1：环境确认（Day 1）

1. 确认 `config/agents.yaml` 中四模型能力标签已配置。
2. 确认 `src/engine/events.js` 中事件常量与 `buildMessage()` 已就绪。
3. 确认 Blackboard、Event Bus、Agent Runtime 可正常启动。
4. 跑通现有测试：`node tests/verification.js`。

### 阶段 2：DAG 构建与校验落地（Day 1-2）

1. 在 `src/engine/scheduler.js` 中实现 `buildDag(taskRequest)`：
   - 优先使用主 Agent 规划结果；
   - 失败或无规划时回退默认 DAG 模板；
   - 调用 `validateDag()` 做依赖存在性、环路、入口点校验。
2. 将 DAG 写入 `blackboard:task:{trace_id}:dag`。
3. 初始化所有子任务状态为 `PENDING`。

### 阶段 3：调度循环落地（Day 2-3）

1. 实现 `getReadySubtasks(taskId, dag)` 依赖就绪检测。
2. 实现 `ConcurrencyLimiter` 并发控制。
3. 实现事件驱动的调度循环：
   - 监听 `SUB_TASK_SUCCESS / SUB_TASK_FAIL / SUB_TASK_TIMEOUT`；
   - 每次事件后触发就绪检测与任务下发；
   - 全部完成后触发 `TASK_ALL_FINISH` 并执行汇总。
4. 实现 `buildSubtaskInput()` 上游输出注入（≤8000 字符）。

### 阶段 4：容错与心跳落地（Day 3-4）

1. 实现指数退避重试与换模型策略。
2. 实现子任务超时检测与 `blackboard:running:{sub_id}` TTL 僵尸回收。
3. 将进程内心跳广播为 `AGENT_HEARTBEAT_EVENT`（跨进程部署必需）。
4. 实现 `TASK_CANCEL_EVENT` 与 `TASK_FINAL_FAIL_EVENT` 处理。

### 阶段 5：协议补齐与可观测性（Day 4-5）

1. 在 `_dispatchSubTask` 内补发 `SUB_TASK_DISPATCH_EVENT`，供外部观测。
2. 补齐 `TASK_PLAN_DISPATCH_EVENT` / `TASK_DEPEND_READY_EVENT` 的事件驱动闭环。
3. 确保 `collab:subtask:update`、`collab:subtask:done`、`collab:planned` 正确推送到前端。
4. 验证 `logs/events/` 与 `logs/collab/` 输出完整。

### 阶段 6：验收测试（Day 5-6）

1. 编写端到端测试用例：
   - 简单串行 DAG（A → B → C）；
   - 并行 DAG（A、B 并行 → C 汇总）；
   - 失败重试（模拟 Agent 失败 2 次后成功）；
   - 超时回收（模拟 Agent 不返回）；
   - 任务取消（用户中途取消）。
2. 跑通 `node tests/verification.js` 与新增测试。
3. 更新 `features/INDEX.md` 记录本方案状态为「已完成」。

---

## 九、风险与后续演进

### 9.1 当前风险

1. **模型调用超时**：CLI 启动 + 生成可能超过 240s，长任务仍存在失败风险。
2. **上下文长度**：上游输出注入限制 8000 字符，超长 DAG 需摘要或 RAG。
3. **黑板文件 I/O**：高并发下文件读写可能成为瓶颈，后续可平滑替换为 Redis。
4. **能力画像静态化**：当前基于配置，未根据历史执行表现动态更新。

### 9.2 后续演进

1. **人工介入点**：在评审失败或关键节点允许用户选择「通过 / 重试 / 跳过 / 指定 Agent」。
2. **动态能力画像**：根据 Agent 历史成功率、延迟、负载更新画像权重。
3. **更多标准化 Skill**：代码审查、测试生成、文档生成等。
4. **持久化层可插拔**：黑板接口抽象，支持从文件版无缝切换到 Redis。
5. **跨任务经验复用**：将成功 DAG / Skill 模板沉淀为可复用工作流。
