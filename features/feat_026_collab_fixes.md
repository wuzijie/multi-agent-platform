# feat_026 修复串行协作第二个子任务失败 + 模型间消息传递追踪日志

## 需求

1. 事件驱动协作串行执行时，第二个子任务（依赖上游输出的）稳定报错
   （`克劳德: Unknown error`），需查找原因并修复
2. 增加日志追踪消息在模型间的传递过程

## 排查结论

### 根因 1：适配器 60 秒超时杀进程（第二个子任务报错的直接原因）

- 日志证据：`logs/agent/2026-08-24_19.log` 中克劳德适配器连续 6 次
  `Unknown error`；`logs/events/2026-08-24T11-51-11-089Z_SUB_TASK_FAIL_EVENT.json`
  记录 `error_msg: "克劳德: Unknown error", error_code: ALL_AGENTS_FAILED`
- 时间线还原：流式开始 11:50:11.066 → 结束 11:51:11.082，**恰好 60.0 秒**
- 原因：四个适配器的 spawn 超时下限都是 60 秒（`Math.max(60000, …)`）。
  克劳德 CLI 启动约需 10-20 秒，慢模型（DeepSeek 后端）完成长任务超过 60 秒，
  进程被 spawn timeout 在 60 秒时 SIGTERM 杀掉 → `exit_code === null`、
  stderr 为空 → 报 `Unknown error` → 调度器重试 3 次全部同样被杀 → 整条 trace 失败

### 根因 2：依赖子任务收不到上游输出（模型间通信缺失）

- 黑板证据：sub_001 的 instruction 为「基于已搜集的素材，设计文章的整体大纲…」，
  但 sub_000（搜集素材，产出约 3KB）的输出从未传给 sub_001
- 下游模型对上游产出完全无感知，只能凭空猜测「素材」内容

## 实现

### 1. 适配器超时修复（四个适配器统一）

- `src/adapters/claude.js` / `kimi.js` / `deepseek.js` / `qwen.js`：
  - 超时下限 60 秒 → **240 秒**（调度器子任务预算 300 秒，留出事件处理余量，
    避免适配器与调度器同时处理同一子任务形成竞态）
  - `_runCli` / `_runStreamingCli` 增加 `startAt` 与 `killed_by_timeout` 判定：
    `code === null`（被信号杀死）或运行时长达到超时上限
  - 失败分支：`killed_by_timeout` 时报明确错误
    `模型调用超时（超过 X 秒无结果，进程已被中断）`，errorCode `TIMEOUT`，
    不再报误导性的 `Unknown error`
- `deepseek.js` / `qwen.js` 直连 API 路径：API 请求超时（错误含「超时」）时
  **直接按 TIMEOUT 失败走调度器重试**，不再回退 CLI——
  CLI 走的是同一 API，回退只会再耗一轮超时并突破调度器 300 秒预算

### 2. 子任务间传递上游输出

- `src/engine/scheduler.js` `_dispatchSubTask`：
  - 解析子任务 `deps`，逐个读取上游子任务黑板状态的 `output`
  - 注入 `subTask.context`，格式：

    ```
    === 上游任务输出（供参考，据此完成本子任务） ===
    【上游子任务 xxx__sub_000 的输出（由 吉米 完成）】
    <输出内容>
    ```

  - 单个上游输出最多注入 8000 字符（超出截断并注明原长度），防上下文爆炸
  - DAG 保证依赖 SUCCESS 才就绪，无输出的依赖自动跳过（兜底）

### 3. 模型间消息传递追踪日志（logs/collab/）

- 新增 `src/utils/collab-logger.js`（JSONL，按小时滚动 `YYYY-MM-DD_HH.log`，
  多日志根目录写入 + 静默容错，与 model-logger 同模式）
- 记录事件（每条含 timestamp + trace_id）：
  - `plan`：DAG 生成（来源 default/llm/llm_fallback + 子任务列表 + 依赖）
  - `dispatch`：子任务下发（模型分配 + instruction + **注入的上游模型输出摘要**
    —— 消息在模型间传递的核心记录，含上游 agent、字符数、内容预览）
  - `agent_result`：每个模型的执行结果（成功内容 / 失败原因 + 耗时）
  - `retry`：重试（次数/上限/退避/原因）
  - `timeout`：超时处理（重试 or 判失败）
  - `sub_fail`：子任务最终失败（重试耗尽）
  - `all_finish`：顶层任务完结（成功 / 失败 + 汇总）
- 挂接点：`_onTaskCreate`（plan）、`_dispatchSubTask`（dispatch + agent_result）、
  `_onSubTaskFinish`（retry / sub_fail）、`_onTimeout`（timeout）、
  `_onAllFinish`（all_finish）

### 4. 事件驱动模式补写用户消息

- `src/orchestrator/orchestrator.js` `_executeEventDrivenCollaboration`：
  入口处 `_appendConversation(taskId, 'user', userMessage, { target: executor_agent })`，
  与其他模式保持一致（此前事件驱动模式的对话里只有助手/系统消息，缺用户提问）

## 验证方式

1. `npm start` 后发起一个多子任务协作请求，观察：
   - 第二个及后续子任务能引用上游输出完成（不再报 Unknown error）
   - `logs/collab/` 出现按小时滚动的 JSONL，逐条可还原
     「plan → dispatch（含上游输出）→ agent_result → … → all_finish」全链路
   - 对话里能看到用户提问 + 各模型输出 + 协作结果
2. 若仍超时，错误信息为「模型调用超时（超过 240 秒无结果，进程已被中断）」，
   可通过调度器重试恢复，不会再看到 `Unknown error`

## 追加修复（2026-08-24 用户反馈两个体验问题）

### 问题 1：对话中间结果在其他模型输出时消失，最后又出现

- 原因：前端在 `task:*` / `collab:planned` / `collab:subtask:done` 事件时都触发
  `fetchConversation`，多个请求并发时**响应乱序返回**——轮次开始时
  `task:executing` 触发的旧请求（不含本轮中间结果）后到时，覆盖掉较新的
  对话状态；下一次子任务完成事件触发刷新后内容恢复，轮次结束时的最终刷新
  再全部补齐。消失恰好发生在模型流式输出期间（期间无刷新事件，没人把它拉回来）
- 修复（`frontend/index.html`）：
  - `convSeqRef` 自增序号：每次 fetch 前取号，响应返回时序号已过期则丢弃，
    只应用最新一次请求的响应（conversation.md 只追加不删减，后发请求内容必然
    不旧于先发请求）
  - 顺带修复 WebSocket 重复推送：server.js 此前对每个 `task:*` 事件同时
    通过命名订阅和 `*` 通配订阅发送两次，前端重复刷新放大竞态，现只保留 `*`

### 问题 2：第二次输入时右侧任务列表不完整，一个任务结束后才输出下一个

- 原因：`/tasks/:id/collab/state` 优先使用 `task.collab_trace_id`，而该字段
  **只在回合结束后**才更新。第二轮执行期间它仍指向第一轮的 trace，
  `collab:planned` 触发的刷新把面板覆盖成旧回合列表；新回合的子任务只能靠
  WS `collab:subtask:update` 逐条重新合并回来（RUNNING/SUCCESS 各到一次出现一次）
- 修复：
  - `src/api/server.js`：改为**始终扫描黑板**，取该 task_id 下 `create_time`
    最新的 trace（新回合 trace 在执行开始时即创建），扫描不到才回退
    `collab_trace_id`
  - `frontend/index.html`：拉取面板列表时与服务端列表**合并**而非覆盖，
    本地已推进的状态（RUNNING/SUCCESS）不回退，同时剔除其他回合残留条目；
    WS 面板更新增加 `task_id` 过滤（配合 `activeIdRef`），只接受当前对话任务

## 2026-08-25 增补：流式气泡与正文交接的"真空期"修复

症状：模型流式输出结束后气泡立即删除，但正文要等 collab:subtask:done -> 写 conversation -> 前端重新 fetch -> 响应返回才出现；并行执行时服务器繁忙 fetch 延迟数秒，表现为该模型输出"消失"，其他模型输出完成后才再次出现。

修复（frontend/index.html）：
- agent:stream:end 不再立即删除气泡，改标记 done（去打字动画，显示"已完成"）继续展示
- fetchConversation 成功后清理 done 超过 1.5s 的气泡（此时正文已渲染，无缝交接）
- 兜底定时器：done 超过 8s 的气泡强制移除（异常流无 subtask:done 触发刷新的场景）
