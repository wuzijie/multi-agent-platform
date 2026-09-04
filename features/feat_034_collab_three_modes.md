# 三类协作模式技术实现方案

> 基于《多Agent三类协作模式标准化落地实现方案》，融合黑板存储、结构化摘要按需读取全量、barrier 回收、主模型编排等架构设计。

## 一、统一基础架构

三种协作模式共享同一套底层机制，差异仅在轮次规则与参与者调度策略。

### 1.1 核心机制

**一次性 CLI + 平台注入历史**：每次调用模型都 spawn 新 CLI 进程，模型无状态。平台每轮从黑板读取历史结构化摘要，拼成 context 注入给模型。模型靠"重读历史"模拟记忆。

**黑板存储层**：所有中间输出（全量正文 + 结构化摘要）存入文件版黑板（`src/blackboard/blackboard.js`，hset/hget/hgetall/keys）。每个 Agent 产出的每条输出都有唯一 key，其他模型通过摘要里的键值按需拉取全量。

**结构化摘要 + 全量键值注入**：模型每次输出在正文末尾附加结构化块（`[DISCUSSION_MSG]...[/DISCUSSION_MSG]`），包含核心观点、关键论据、疑问、状态等字段 + 全量存储键值。平台解析后存入黑板。下一轮注入给其他模型时，给的是精简摘要列表（每条带发送者 + 键值），而非全文。模型判断需要某条全量细节时，用 `fetch_full` 工具拉取。

**主模型编排 + barrier 回收**：主模型（克劳德）是唯一发起者。每轮输出 task list（每条带 executor + instruction + deps）。无 deps 的并行扇出，有 deps 的等上游 barrier 后串行触发。当前轮所有并行子任务完成后（barrier），摘要回收注入主模型下一轮 context。

**响应模型不能 @其他模型**：执行者只能 `reply_to` 主模型，不能扩散讨论。所有扇出由主模型决定。

### 1.2 流程概览

```
用户发消息 + 选择协作模式
    ↓
主模型输出本轮 task list（executor + instruction + deps）
    ↓
平台解析 task list → 扇出并行调用各执行者
    ↓
每个执行者收到 context（讨论主题 + 历史摘要 + 本轮指令 + 全量键值）
    ↓
执行者输出全量 + 结构化摘要 → 存黑板
    ↓
barrier：当前轮所有子任务完成 → 摘要收集
    ↓
主模型下一轮 context：已完成子任务摘要列表 + 全量键值
    ↓
主模型决定：继续分发 / 汇总输出 / 结束
```

## 二、黑板存储规范

### 2.1 Key 命名

| 用途 | Key 格式 | 存储方式 |
|------|----------|----------|
| 讨论元数据 | `blackboard:disc:{traceId}:meta` | hset：topic / mode / participants / current_round / status |
| 单条消息全量 | `blackboard:disc:{traceId}:full:{msgSeq}` | set：完整正文 |
| 单条消息摘要 | `blackboard:disc:{traceId}:summary:{msgSeq}` | hset：sender / type / round / core_view / key_points / questions / status / reply_to / full_key / converged |
| 轮次屏障 | `blackboard:disc:{traceId}:barrier:{round}` | hset：expected / completed / created_at（setex TTL 300s） |
| 重发计数 | `blackboard:disc:{traceId}:retry:{originalMsgSeq}` | hset：retry_count / last_error / last_status |

`msgSeq` 为递增序号（0, 1, 2...），每条消息唯一。`traceId` 为整次讨论的唯一标识。

### 2.2 生命周期

- 讨论开始时创建 meta，结束时标记 `status: finished`
- 全量和摘要不设 TTL（持久留存，供迭代续跑）
- barrier 键设 TTL 300 秒（超时自动清理僵尸 barrier）
- 重发计数键不设 TTL（讨论期间持续累计）

## 三、结构化摘要格式

模型每次输出在正文末尾附加如下标记：

```
[DISCUSSION_MSG]
{
  "core_view": "核心观点/核心结论（1-3句话）",
  "key_points": ["关键论据1", "关键论据2"],
  "questions": ["待讨论的疑问1"],
  "status": "success|failed|timeout",
  "reply_to": "主模型该轮分发的msgSeq",
  "converged": false
}
[/DISCUSSION_MSG]
```

平台解析后存入黑板的 `summary:{msgSeq}`。`full_key` 由平台自动填入（`blackboard:disc:{traceId}:full:{msgSeq}`），模型不需要写。

**分层裁剪规则**（注入历史时）：
- 最近 3 条消息：完整摘要（所有字段）
- 更早的消息：仅 `core_view` + `status` + `full_key` + `sender`
- 所有消息的全量键值始终保留在摘要里，模型可随时 `fetch_full` 拉取

## 四、模式一：多方辩论·模型正反对抗模式

### 4.1 模式参数

- 参与者：3-5 个已启用 Agent（用户指定或主模型根据主题选取）
- 主模型：克劳德（编排者，不参与观点输出）
- 轮次：6 轮固定 + 可迭代（最多 3 次迭代）
- 单次观点点评：1-2 个异地 Agent

### 4.2 六轮调度流程

**第一轮：并行观点发散**

主模型 task list：
```
[
  { executor: "迪普斯克", instruction: "基于主题输出初始观点...", deps: [] },
  { executor: "钱文", instruction: "基于主题输出初始观点...", deps: [] },
  { executor: "吉米", instruction: "基于主题输出初始观点...", deps: [] }
]
```
- 全部无 deps，并行扇出
- 每个 Agent 收到的 context：讨论主题 + 约束条件 + 输出要求（核心观点/支撑依据/潜在局限/适用场景）
- 约束：各 Agent 观点独立，不互相参考
- barrier 回收后，3 条摘要存黑板

**第二轮：交叉匿名点评**

主模型从黑板读取第一轮所有摘要，分配交叉点评：
```
[
  { executor: "迪普斯克", instruction: "点评以下观点（钱文的观点）：[摘要]...", deps: [] },
  { executor: "钱文", instruction: "点评以下观点（吉米的观点）：[摘要]...", deps: [] },
  { executor: "吉米", instruction: "点评以下观点（迪普斯克的观点）：[摘要]...", deps: [] }
]
```
- 硬性规则：禁止 Agent 点评自身，平台在分配时校验 `executor != 被点评者`
- 点评内容：逻辑漏洞、论据缺陷、对立观点、补充建议
- 可选：每条观点分配 1-2 个点评者（当 X=3 时每条 1 个，X≥4 时每条 2 个）
- barrier 回收后，点评摘要存黑板

**第三轮：自我辩解 + 观点初修正**

主模型为每个第一轮参与者分配"回应针对自己的所有点评"：
```
[
  { executor: "迪普斯克", instruction: "以下是针对你第一轮观点的点评，逐一回应辩解并修正：[点评摘要列表]...", deps: ["msgSeq_点评1", "msgSeq_点评2"] }
]
```
- deps 指向第二轮中针对该 Agent 的点评消息
- 平台通过 deps 注入上游点评的摘要 + 全量键值
- Agent 区分合理建议与无效质疑，吸收有效意见，输出修正版观点
- 分支优化：若所有点评无分歧且观点完全统一，主模型跳过第四轮直接进第五轮

**第四轮：二次交叉点评**

复刻第二轮规则，针对第三轮修正后的新观点重新分配交叉点评：
- 聚焦修正后的新增内容、残留争议、未解决分歧
- 同样禁止自评

**第五轮：终修正 + 共识分歧拆解**

主模型为每个参与者分配"整合两轮点评的终修正"：
```
[
  { executor: "迪普斯克", instruction: "整合第二轮和第四轮的全部有效信息，输出最终个人观点。统一输出：全员共识清单、核心分歧清单、未解决争议点、各自立场总结", deps: ["所有点评msgSeq"] }
]
```
- 每个 Agent 输出结构化的共识/分歧/立场
- barrier 回收后，主模型从所有终修正摘要中提取全局共识/分歧

**第六轮：终止判定 / 迭代续跑**

- 主模型输出结构化块：`phase: "converge"`，包含全局共识、核心分歧、待论证问题
- 前端展示"结束讨论"和"继续迭代"按钮
- 继续迭代：清空前四轮冗余上下文，仅保留第五轮最终观点 + 共识 + 分歧作为新初始数据，重复第二轮至第五轮
- 迭代上限 3 次

### 4.3 模式一输出

各 Agent 最终修正观点、全局共识集合、核心分歧集合、待进一步论证问题清单。

## 五、模式二：头脑风暴·思维发散收敛模式

### 5.1 模式参数

- 发散层 Agent：X≥3 个
- 收敛层 Agent：1-2 个（不参与发散）
- 终收敛 Agent：1 个（不参与发散和收敛）
- 主模型：克劳德（编排者）
- 轮次：3 轮固定

### 5.2 三轮调度流程

**第一轮：定向差异化头脑风暴**

主模型为每个发散 Agent 分配独立思考维度：
```
[
  { executor: "迪普斯克", instruction: "从【风险分析】维度思考主题...", deps: [] },
  { executor: "钱文", instruction: "从【落地思路】维度思考主题...", deps: [] },
  { executor: "吉米", instruction: "从【创新方案】维度思考主题...", deps: [] }
]
```
- 并行扇出
- 维度分配由主模型根据主题和参与者能力画像决定
- 目标：最大化观点多样性

**第二轮：分层首次收敛**

根据发散 Agent 数量差异化适配：
- X=3：选取 1 个收敛 Agent，汇总全部 3 组观点
- X≥4：选取 2 个收敛 Agent，无重复分组收敛（A 负责前 X/2 组，B 负责后 X/2 组）

```
// X=3 示例
[
  { executor: "克劳德", instruction: "汇总以下3组发散观点，输出初步共识、分歧、整合方案：[摘要列表]...", deps: ["msgSeq_发散1", "msgSeq_发散2", "msgSeq_发散3"] }
]
```
- 硬性约束：收敛 Agent 不得参与第一轮发散
- 收敛 Agent 收到的是各发散 Agent 的结构化摘要 + 全量键值
- 输出：初步收敛结论、共识与分歧

**第三轮：终极二次收敛**

选取 1 个未参与前两轮的全新中立 Agent：
```
[
  { executor: "中立Agent", instruction: "对以下收敛结果进行合并、去重、补全、择优，输出最终综合结论：[收敛摘要]...", deps: ["msgSeq_收敛1"] }
]
```
- 剔除无效观点、合并重复思路、保留优质创意、补齐逻辑短板
- 输出唯一、完整、可落地的最终综合结论

### 5.3 模式二输出

全维度发散观点汇总、分层收敛过程记录、最终整合结论、方案优化建议、废弃观点说明。

## 六、模式三：一对一极简辩论模式

### 6.1 模式参数

- 参与者：固定 2 个 Agent（A、B）
- 主模型：克劳德（编排者）
- 轮次：2-5 轮交替，可变

### 6.2 交替对抗调度流程

**步骤1：初始化**

用户指定或主模型选取 2 个 Agent，输入辩论主题与约束。

**步骤2：交替对抗循环**

主模型按交替顺序逐轮调度（串行，每轮 1 个 Agent）：

```
// 第1交互轮
[{ executor: "AgentA", instruction: "输出核心观点...", deps: [] }]

// barrier 回收后

// 第2交互轮
[{ executor: "AgentB", instruction: "针对以下观点进行点评、反驳、补充：[A的摘要]...", deps: ["msgSeq_A1"] }]

// 第3交互轮
[{ executor: "AgentA", instruction: "针对B的点评进行辩解、修正、反驳：[B的摘要]...", deps: ["msgSeq_B2"] }]
```

- 交替规则：A -> B -> A -> B ...
- 最少 2 轮完整交互
- 最多 5 轮强制终止
- 每轮 task list 只有 1 条（串行），deps 指向上一轮的消息
- 每次 barrier 是单任务完成即回收

**收敛判定**：达到最小轮次后，主模型检查最新两轮的摘要是否出现"双方都标记 converged: true"或"观点趋于稳定"（核心观点不再变化）。满足则进入收尾，不满足继续交替。

**步骤3：收尾总结**

```
[{ executor: "AgentA", instruction: "统筹总结双方共识、核心分歧、各自坚守立场、问题最终结论", deps: ["所有msgSeq"] }]
```

### 6.3 模式三输出

完整辩论交互记录、双方共识清单、核心分歧清单、最终研判结论。

## 七、与现有架构集成

### 7.1 编排器入口

在 `orchestrator.js` 的 `executeSimpleTask` 中新增协作模式分支：

```
if (opts.collab_mode === 'debate')      -> _executeDebateMode(task, taskId, userMessage, opts)
if (opts.collab_mode === 'brainstorm') -> _executeBrainstormMode(task, taskId, userMessage, opts)
if (opts.collab_mode === 'duel')       -> _executeDuelMode(task, taskId, userMessage, opts)
```

三种模式的方法实现放在 `src/orchestrator/collab-modes.js`（通过 prototype 赋值接入，与 collab.js / execution.js 同模式）。

### 7.2 通用调度原语

三种模式共享以下原语（提取到 `collab-modes.js` 的工具方法）：

**`_discRound(taskId, traceId, taskList, round)`**：执行一轮讨论
1. 为每条子任务生成 msgSeq，存 meta
2. 并行扇出调用各 executor（Promise.allSettled）
3. 每个执行者的 context 由 `_buildDiscContext` 拼装
4. 执行者输出解析结构化块，全量 + 摘要存黑板
5. barrier 回收，返回本轮所有摘要

**`_buildDiscContext(traceId, taskId, instruction, deps)`**：拼装 context
1. 读讨论 meta（主题、模式、当前轮次）
2. 读历史摘要列表（分层裁剪：近 3 条完整，更早仅 core_view + full_key）
3. 如有 deps，读依赖消息的摘要（完整字段）+ full_key
4. 拼成 context 字符串

**`_parseDiscMsg(content, msgSeq, traceId)`**：解析模型输出
1. 提取 `[DISCUSSION_MSG]...[/DISCUSSION_MSG]` JSON 块
2. 全量正文 = 去掉标记后的内容
3. 结构化摘要 = JSON 解析结果 + full_key
4. 存入黑板（full + summary）
5. 返回 { msgSeq, summary }

**`_discFetchFull(args, ctx)`**：fetch_full 工具 handler
1. `args.key` = 黑板键值
2. `blackboard.get(key)` 返回全量正文
3. 作为工具结果回灌给模型

### 7.3 适配器调用

复用现有 `agentRuntime.executeTaskWithAgent`，传入：
- `task.task_id = subTaskMsgSeq`（关联黑板）
- `task.external_task_id = taskId`（对话级，流式事件/进程管理用）
- `task.trace_id = traceId`（讨论级）
- `task.instruction = 子任务指令`
- `task.context = _buildDiscContext 拼装的 context`
- `task.disableTools = false`（允许 fetch_full 工具调用）
- 流式 onChunk 透传到前端（复用 `agent:stream:*` 事件）

### 7.4 事件推送

复用现有事件机制：
- `agent:stream:start/chunk/end`：流式输出（前端气泡）
- `disc:round:start` { traceId, round, mode }：新一轮开始
- `disc:round:done` { traceId, round, summaries }：一轮完成
- `disc:converged` { traceId, consensus, divergences }：讨论收敛
- `disc:failed` { traceId, error }：讨论失败

前端新增讨论模式选择器（debate / brainstorm / duel），发送时带 `collab_mode` 字段。

### 7.5 fetch_full 工具注册

在 `skills/` 下新增 `fetch_full.md`（prompt 型 skill，但实际是 module 型）：

```yaml
---
id: fetch_full
name: 按需读取全量内容
description: 在多模型协作讨论中，按键值拉取某条消息的完整正文
enabled: true
tool:
  name: fetch_full
  description: 按键值拉取某条讨论消息的完整正文（当你需要某条消息的详细内容时调用）
  parameters:
    type: object
    properties:
      key:
        type: string
        description: 消息的全量存储键值（在历史摘要中标记为 full_key）
    required:
      - key
execution:
  type: module
---
```

handler 实现在 `src/skills/fetch-full.js`，导出 `handler(args, ctx) { return blackboard.get(args.key); }`。

## 八、失败 / 重发 / 终止规则

### 8.1 子任务失败

执行者输出 `status: failed` 或 CLI 调用抛异常 -> 平台标记该 msgSeq 为 failed -> 主模型下一轮 context 中该条摘要带 `status: failed` -> 主模型决定重发：

```
// 主模型重发 task list
[{ executor: "迪普斯克", instruction: "(同原指令)", retry_of: "原msgSeq", deps: [...] }]
```

平台看到 `retry_of` -> 读 `blackboard:disc:{traceId}:retry:{originalMsgSeq}` -> `retry_count + 1`。超过 3 次 -> 整个讨论标记 `status: failed`，写入 `disc:failed` 事件，终止。

### 8.2 超时

子任务超时阈值 120 秒（讨论型任务不需要太长）。超时 -> 标记 `status: timeout` -> 同失败流程，主模型可重发。

### 8.3 自动终止

- 全局 100% 共识（所有参与者最新一轮都标记 `converged: true`）-> 自动终止，输出结论
- 达到模式最大轮次 -> 强制终止
- 用户手动终止 -> 即时输出当前最新结果

### 8.4 无效输出兜底

单 Agent 输出空内容 / 重复内容 / 无意义内容 -> 平台检测（空正文或摘要 core_view 为空）-> 标记 `status: failed` -> 由其他 Agent 补位（主模型重新分配该点评/收敛任务给其他 Agent），不中断整体流程。

### 8.5 上下文迭代续跑

模式一支持迭代：清空前四轮冗余上下文，仅保留第五轮的最终观点、共识、分歧作为新初始数据。实现方式：
- 不删除黑板中的旧数据（保留审计轨迹）
- meta 中标记 `iteration: N`，下一轮注入历史时只从 `iteration: N` 的第五轮消息开始读
- 迭代上限 3 次

## 九、前端展示

### 9.1 讨论模式选择器

在现有协作模式选择器旁新增三个选项：
- 多方辩论（debate）
- 头脑风暴（brainstorm）
- 一对一辩论（duel）

发送时 `collab_mode` 字段带对应值。

### 9.2 讨论过程展示

- 复用现有流式气泡（每条消息一个气泡，标记发送者）
- 右侧任务面板展示当前轮次 / 参与者 / 状态
- 模式一轮次面板：6 轮进度条
- 模式二轮次面板：3 轮进度条
- 模式三轮次面板：当前交互轮 / 5

### 9.3 结果展示

讨论结束后，主模型输出结构化结果（共识/分歧/结论/待论证问题），前端渲染为分组卡片。

## 十、文件清单

| 文件 | 说明 |
|------|------|
| `src/orchestrator/collab-modes.js` | 三种模式的调度逻辑（prototype 赋值接入 orchestrator） |
| `src/skills/fetch_full.md` | fetch_full 工具定义（md 驱动） |
| `src/skills/fetch-full.js` | fetch_full handler 实现 |
| `frontend/index.html` | 新增讨论模式选择器 + 结果展示 |
| `src/orchestrator/orchestrator.js` | executeSimpleTask 新增三个 collab_mode 分支 |
| `src/engine/events.js` | 新增 disc:* 事件常量 |

## 十一、与已有协作模式的关系

| 模式 | 编排方式 | 流程灵活性 |
|------|----------|------------|
| 事件驱动协作（event-driven） | DAG 一次性规划 + scheduler 调度 | 一次性输出完整 DAG |
| 讨论模式（discussion_agents） | 固定流程（A答->B/C评->A改） | 固定轮次循环 |
| 多方辩论（debate） | 主模型按6轮规则编排 | 固定6轮+可迭代 |
| 头脑风暴（brainstorm） | 主模型按3轮规则编排 | 固定3轮 |
| 一对一辩论（duel） | 主模型按交替规则编排 | 2-5轮可变 |

三种新模式与已有模式的区别：中间输出全部存黑板、结构化摘要 + 全量键值按需读取、主模型动态编排（而非一次性 DAG）。可共存，用户通过 `collab_mode` 字段选择。
