# 多 Agent 协作平台 · 面试题库

> 按项目真实实现整理，难度标注：★ 基础 / ★★ 进阶 / ★★★ 深入（可继续追问）。
> 建议面试时先让对方讲整体链路，再按模块逐层下钻。答案给的是"及格线"，追问看深度。

---

## 一、总体架构（10 题）

**Q1 ★ 请用三分钟讲清楚一条用户消息从进入系统到返回的完整链路。**
A：`POST /api/tasks/:id/execute` → `executeSimpleTask` 按模式路由（单聊 / @讨论 / debate-brainstorm-duel / event-driven）→ 单聊走 `_executeAgentWithMentions`，事件驱动走 `scheduler.createTask` → 最终都落到 `agentRuntime.executeTaskWithAgent` → 适配器拼 prompt 并 spawn CLI → 流式事件经 EventBus 推到 WebSocket → 结果写 conversation.md 并返回。

**Q2 ★★ 为什么有 orchestrator、scheduler、runtime、adapter 四层？各层边界是什么？**
A：orchestrator 负责"对话语义与模式路由"，scheduler 负责"DAG 状态机与调度"，runtime 负责"Agent 生命周期与调用/工具循环"，adapter 负责"具体 CLI 的进程与输出解析"。边界靠统一输入输出结构（UnifiedInput/UnifiedOutput）约束，换模型只改 adapter。

**Q3 ★★ orchestrator 用 `Object.assign(prototype, require('./xxx'))` 把方法拆到多个文件，代价是什么？**
A：方法共享 `this`，但文件内的裸标识符（`fs`、`path`、`ROOT`、`CollabLogger`）各自 require，拆文件时极易漏掉；`this.xxx()` 的存在性也不受编译器检查。项目里确实踩过：拆完出现缺少 `fatalAgents`、`TASK_TYPES`、`ROOT`，以及 `terminateTask` 被误删导致 500。缓解办法是静态扫描（去注释后比对裸标识符 + 校验方法存在）。

**Q4 ★★ 单例 scheduler 在多对话并发下安全吗？共享可变状态有哪些？**
A：`_pending`（traceId→Promise）、`_timers`（subId→定时器）、`_rr`（轮转计数）、`_taskSeq` 是跨对话共享的。`_pending`/`_timers` 以唯一 ID 为键，天然隔离；`_rr` 共享只影响分配顺序，不影响正确性。真正需要注意的是"同一 trace 的重复派发"，靠派发前同步写 RUNNING 状态挡住。

**Q5 ★★ 为什么不常驻一个模型进程，而是每次 spawn？**
A：常驻进程会绑定单一对话，无法让同一模型服务多个并发对话；也难以精准停止某个对话。spawn 的代价是启动开销（克劳德 CLI 约 10–20 秒）和每轮重发上下文，换来的是隔离性、可取消性和并发能力。

**Q6 ★★★ 如果要支持多机部署，哪些设计假设会先破？**
A：黑板是本地文件、事件总线是进程内 EventEmitter、scheduler 是单例、procRegistry 只能杀本机进程。要改的包括：黑板换 Redis、事件换带持久化和 ack 的消息队列、调度器加分布式锁或按 trace 分片、进程管理下沉到各节点。现有"幂等 + 状态重算"的语义可以保留。

**Q7 ★★ 系统的"唯一事实源"是什么？为什么这样设计？**
A：黑板（`blackboard:task:{traceId}:*`）是状态唯一事实源，模型只读不写。调度、UI、日志都从黑板派生，避免多处各自记录导致不一致。

**Q8 ★★ 哪些模块之间是直接调用，哪些走事件？判断依据是什么？**
A：控制流（规划、派发、就绪重算）是直接调用；"结果通知"（子任务完成、取消）和"对外广播"（流式、UI 刷新）走事件。判断依据是：需要解耦/广播/异步化的用事件，需要明确时序和返回值的用调用。

**Q9 ★★★ 这个项目里最明显的"过度抽象"或"未完成抽象"是什么？**
A：过度的是事件常量表定义了十几个从未 emit 的事件（TASK_DEPEND_READY、SUB_TASK_DISPATCH 等），容易误导维护者；未完成的抽象是 prompt 模板——四个 adapter 原本各写一份，刚抽成共享模板，但 DAG/讨论仍有各自的拼装逻辑。

**Q10 ★★ 如果让你重做一遍，哪一处架构决策会改？**
A：把"对话上下文"和"展示记录"从一开始就拆成两份（transcript vs conversation），而不是复用 conversation.md 反推历史；另外调度器的失败级联（FAILED 节点让下游 SKIPPED）应该在第一版就有。

---

## 二、DAG 调度（16 题）

**Q11 ★ DAG 是怎么生成的？**
A：`plannerMode='llm'` 时由主 agent（克劳德）读 `skills/task_planning.md` 指令，输出 JSON 数组（type/instruction/deps/agent）；解析失败或校验不通过回退内置 `defaultDag`（规划→执行→评审→汇总）。

**Q12 ★★ `_dispatchReady` 为什么每次都全量扫描子任务？复杂度如何？**
A：因为它把黑板当事实源，每次收到完成事件就重算"哪些 PENDING 的依赖已全部 SUCCESS"，不维护边→订阅者映射。单次 O(N) 文件读，全部完成是 O(N²)。N 很小（2–5 节点）时可接受，节点多时应改成增量更新或内存索引。

**Q13 ★★★ 为什么不做"依赖就绪事件"（TASK_DEPEND_READY），而是重算？**
A：事件只带"某节点完成"，不带图结构；重算让 DAG 形状变成数据而非代码，重复/乱序事件也能靠状态幂等吞掉。代价是全量扫描和"失败节点下游无人处理"的盲区。

**Q14 ★★★ 中间节点 FAILED 会发生什么？怎么修？**
A：它的下游仍是 PENDING，`_dispatchReady` 找不到就绪节点直接返回；`_onAllFinish` 因 pending 非空永远进不去，`createTask` 的 Promise 既不 resolve 也不 reject，HTTP 请求挂起。修法是 FAILED 时把传递依赖置 SKIPPED，或把"所有节点都是终态"作为完结条件。注意 `SKIPPED` 枚举已定义但从未写入。

**Q15 ★★ 失败重试的完整机制？**
A：子任务全部模型失败 → `SUB_TASK_FAIL` → `_onSubTaskFinish` 把状态置 RETRYING，按 `[0,1,3,5,10]s` 指数退避发 `SUB_TASK_RETRY`，最多 3 次；每次重试生成新 `msg_id`，避免被幂等键误杀。致命错误（402/鉴权/Invalid role）直接 FAILED 且熔断该模型。

**Q16 ★★ 超时有两层，分别是什么？会不会冲突？**
A：适配器进程超时 `max(240s, promptLen*2+30s)`；调度器子任务超时 300s。设计上适配器先于调度器触发，避免被 SIGTERM 后返回空 stderr。两者不会重复处理，因为 `_onTimeout` 会先校验状态仍是 RUNNING。

**Q17 ★★ 重试和超时两套路径会不会造成同一次失败被计两次？**
A：不会。`_onSubTaskFinish` 对非 RUNNING 状态直接 return；`_onTimeout` 也只在 RUNNING 时生效；重试会重置状态并清定时器。

**Q18 ★★ 幂等键的作用范围和 TTL？**
A：`blackboard:idempotent:{msg_id}`，TTL 等于任务超时；`_handle` 入口统一校验。它只防"同一条消息被消费两次"，不防"两个不同消息表达同一意图"。

**Q19 ★★ deps 同时承担了哪两个语义？有什么问题？**
A：执行顺序 + 上下文注入范围。注入只遍历直接 deps，不递归祖先；因此需要祖先原文必须显式把祖先写进 deps。钻石型 DAG 默认拿不到根节点原文。改进方向是拆出 `context_deps`。

**Q20 ★★ 现在对 deps 做了哪些校验？为什么可以不做环检测？**
A：只接受整数/数字字符串，且必须 `0 <= dep < seq`（只能指向更早节点），非法即整份规划回退默认 DAG；节点必须是对象。因为边只指向更早节点，拓扑序天然成立，环不可能出现。

**Q21 ★★★ 为什么选择"整份回退"而不是"丢弃非法边"？**
A：丢边会静默改变执行顺序和上下文注入范围，风险比直接降级到已知安全的默认 DAG 更高。回退是可预期、可观测的失败模式。

**Q22 ★★ 子任务如何选模型？**
A：优先 planner 指定的 `preferred_agent`（需在线且未熔断）；否则按能力画像匹配（任务类型命中优先，再按 load_score 排序），并用 `_rr` 轮转打散。busy 的模型也参与选择，因为同一模型可以并发起多个 CLI 进程。

**Q23 ★★ 模型间是怎么传递信息的？**
A：派发时读取直接依赖子任务的 `output`，单个截断 8000 字符，拼成"上游任务输出"注入子任务 context；下游模型据此继续。日志 `CollabLogger.logDispatch` 记录注入摘要，是排查"下游没看到上游"的核心证据。

**Q24 ★★ 为什么子任务里要 `disableTools=true`？**
A：防止子任务里的模型再调用 deep_research 等工具，形成嵌套调度，导致外层 300s 超时监控与内层 skill 互相打架。原则：工具循环只在用户直接对话一线启用。

**Q25 ★★ planner 的规划调用为什么也要 disableTools？**
A：规划本身就是产出，启用工具会让模型在拆解阶段去执行任务，既浪费 token 也破坏"先规划后执行"的结构。

**Q26 ★★★ 计划器如何理解"把刚才的方案改一下"？**
A：`_planTask` 在提示词尾部注入压缩后的往轮对话（≤6000 字）和上一轮最终结果（≤2000 字）；子任务本身不注入完整历史，只注入 `previous_result`，保持隔离。

---

## 三、事件驱动与状态机（9 题）

**Q27 ★ 系统里哪些事件真正驱动状态机？**
A：5 个：TASK_CREATE、SUB_TASK_SUCCESS、SUB_TASK_FAIL、SUB_TASK_RETRY、TASK_CANCEL。其余是过程/UI/日志事件。

**Q28 ★★ 为什么监听器只做 `_enqueue` + `setImmediate`？**
A：避免"事件回调里同步发事件"造成同步深递归；同时让长任务走 await，不阻塞事件循环。早期黑板/事件同步写盘曾把另一个对话饿死，就是反例。

**Q29 ★★ 事件总线为什么把高频事件排除持久化？**
A：`agent:stream:chunk` 每 80ms 一次，同步 `writeFileSync` 会阻塞 event loop；现在高频事件只走内存，普通事件 `setImmediate + writeFile` 异步落盘。

**Q30 ★★ 事件重复投递时怎么保证不重复执行？**
A：`msg_id` 幂等（黑板写入并检查 TTL）+ 状态守卫（非 RUNNING 的完成回调直接丢弃）+ 派发前同步写 RUNNING。

**Q31 ★★ 取消是怎么工作的？**
A：`stopTask` 先 `procRegistry.killTask(taskId)` SIGKILL 该对话所有 CLI，再找该对话的 trace 逐个 `cancelTask` → `TASK_CANCEL` → `_onCancel` 清定时器/释放模型/把顶层置 CANCELLED 并 resolve Promise；session 标记 `cancelledTurn`。

**Q32 ★★★ 已经在 await 的 `_dispatchSubTask` 能被打断吗？**
A：JS 层不能；但进程已被杀，适配器返回 failed/cancelled。它随后 emit 的事件会被状态守卫丢弃（节点已不是 RUNNING）。

**Q33 ★★ 为什么完成事件 TASK_ALL_FINISH 没有消费者？**
A：它是广播型事件，供日志/WS 观察；真正的完成信号是 `_resolveTask` 直接 resolve Promise，不依赖事件消费。这个设计意味着"事件丢失"不影响主流程，但也意味着不能靠事件做可靠完成通知。

**Q34 ★★★ 如果要做事件重放/崩溃恢复，需要改什么？**
A：事件需要持久化（当前进程内 + 仅审计日志）、消费位点、ack、重放幂等；黑板状态也要可重建（快照 + 增量）。当前架构明确不具备这些。

**Q35 ★★ 如何排查"某子任务没收到上游输出"？**
A：查 `logs/collab/` 的 dispatch 记录（含注入的 dep、模型、字符数、preview）；再核对黑板 `sub:{id}` 的 deps 与上游 status/output；最后看 planner 产出的原始 JSON 是否把祖先写进 deps。

---

## 四、流式输出与前端体验（9 题）

**Q36 ★ 四个 CLI 的流式行为差异？**
A：kimi `--output-format=text` 真流式；qwen 任何格式都缓冲（text 单块、stream-json 文本也延迟到达）；claude `text` 非流式，`stream-json + --verbose` 才真流式。

**Q37 ★★ claude 适配器怎么避免重复输出？**
A：维护 `emittedLen`，解析 `stream_event/content_block_delta/text_delta` 增量；`assistant`、`result` 等汇总事件到达时只补发 `fullText.slice(emittedLen)` 的尾部。

**Q38 ★★ `_streamedExecute` 为什么做 80ms 节流？**
A：CLI 增量可能非常碎，逐个 emit 会造成事件洪泛和 WS 压力；节流后按时间窗合并，既保持体感又不阻塞。

**Q39 ★★ 前端"气泡消失又重现"的根因是什么？**
A：多个竞态叠加——done 气泡被无条件强删、fetch 响应乱序（旧请求后到覆盖新内容）、切换对话时 stale task 渲染。修复是"正文确认前不删气泡"+ 对话长度单调性保护 + activeId 守卫 + 延迟调和。

**Q40 ★★ 为什么不能只靠 stream:end 就删除气泡？**
A：流结束不等于正文已写入 conversation.md；中间要经过 `collab:subtask:done` → 写文件 → 前端 fetch。删除太早会出现"真空期"。

**Q41 ★★ 前端如何避免不同对话的流串台？**
A：stream start/chunk/end 都校验 `task_id === activeIdRef.current`；切换对话先清空 activeTask/conversation/streams 再 fetch；面板合并时过滤非当前 activeId 的更新。

**Q42 ★★ 为什么流式事件不持久化、也不进 conversation.md？**
A：它们是过程信号，不是语义结果；持久化会造成海量小文件并阻塞 IO。可读结果由 collab:subtask:done 和最终答案写入。

**Q43 ★★★ 如果换成一个不支持流式的模型，现有设计如何降级？**
A：适配器返回完整结果，仍会走 `agent:stream:start/end`（只是没有中间 chunk），前端体验变成"等待后整段出现"；上游事件链不变，所以调度和落盘逻辑不需要改。

**Q44 ★★ 流式与"停止本轮"如何配合？**
A：适配器检测进程被杀返回 `cancelled`，runtime 不再解析工具、不再调下一轮；`_streamedExecute` 发带 error 的 stream:end；前端移除气泡；编排层 `_finishStoppedTurn` 收尾但不把任务判为 failed。

---

## 五、并发、会话与取消（9 题）

**Q45 ★ 为什么去掉了全局 BUSY 闸门？**
A：每次调用都 spawn 新 CLI，同一模型可以并发服务多个对话；BUSY 会让一个对话阻塞另一个。现在 busy 只用于观测和画像，不再作为准入门槛。

**Q46 ★★ busy 状态怎么跟踪并发？**
A：`_activeCalls: Map<callId, taskId>`；`_endCall` 全部结束后才置空闲；`forceReleaseTask(taskId)` 只释放指定对话的调用，避免误清其他对话。

**Q47 ★★ 停止任务时如何确保杀到正确的进程？**
A：适配器注册进程时用 `input.external_task_id || input.task_id`（对话 ID），`killTask` 也用对话 ID。之前用子任务 ID 注册、用对话 ID 停止，导致杀不掉、模型继续烧 token。

**Q48 ★★ terminateTask 和 stopTask 有什么区别？**
A：terminate 是"结束对话"，标记 completed，触发记忆归档与提炼；stop 是"停止本轮"，标记 cancelledTurn，任务仍可继续输入。

**Q49 ★★ 为什么取消标志必须在 `beginTurn` 才复位？**
A：如果 occupyAgent/addTrace 等活跃操作也清标志，"停止后仍有并发调用在收尾"会覆盖掉取消状态，导致后续步骤继续执行。

**Q50 ★★ 前端 loading 为什么要按对话维度而不是全局布尔？**
A：`/execute` 是同步阻塞接口，全局布尔会让 A 对话执行期间 B 无法输入。现在是 `busyTasks` 映射 + `__new__` 占位。

**Q51 ★★ 一个对话内的多个子任务会并发读同一模型吗？**
A：会。`agentsPerTask=1` 限制的是单子任务，不同子任务（同批就绪）会并行派发，可能落在同一模型上，靠多进程并发。

**Q52 ★★★ 多对话并发时，Session 的作用是什么？**
A：每个 taskId 一个 Session，记录 traces、busyAgents、cancelledTurn、状态；它不参与模型调度准入，主要用于停止、观测和"本轮是否已取消"的语义。

**Q53 ★★★ 如果某个模型 CLI 启动特别慢（20s），并发很多对话会怎样？**
A：每个对话各自 spawn，进程数线性增长，内存/CPU 和 API 并发都上升；可能触发供应商限流。当前没有全局并发上限和排队机制，这是可以改进的点。

---

## 六、Prompt 构造与上下文管理（14 题）

**Q54 ★ 现在一条 prompt 由哪几部分组成？**
A：固定头（角色、任务ID、要求）+ ZONE A context（工具说明、团队规则、会话目标、冻结记忆）+ ZONE B 历史（transcript 原样拼接）+ ZONE C 当前轮/工具追加。

**Q55 ★★ 为什么把"当前用户消息"放进 `## 对话` 而不是单独的执行指令？**
A：为了让第 N 轮 prompt 成为第 N+1 轮 prompt 的严格前缀；当前消息与历史条目同构，下一个请求只需在尾部追加。

**Q56 ★★ 为什么第 N 轮必须是第 N+1 轮的前缀？**
A：供应商的前缀缓存按 token 前缀匹配；共享前缀可以复用已计算的 KV，降低延迟和成本。进程是否复用无关，缓存发生在服务端。

**Q57 ★★ 为什么长期记忆必须"按会话冻结"？**
A：原实现每轮按当前输入检索相关主题，记忆块每轮变化，位于前缀中会让缓存全部失效。冻结后会话内不变，代价是相关性下降。

**Q58 ★★ 历史是怎么存的？为什么不直接用 conversation.md？**
A：存 `prompt_transcript.jsonl`，按"实际发给模型的片段"原样追加；conversation.md 含时间戳、系统提示、中间阶段输出，格式也会随展示需求变化，无法保证前缀稳定。

**Q59 ★★ 截断为什么必须确定性？**
A：同一内容每次必须渲染成同一文本，否则下一轮前缀对不上。截断用"头 75% + 固定标记 + 尾 25%"，不引入随机或时间因素。

**Q60 ★★ 压缩什么时候发生？为什么不做滑动窗口？**
A：片段数 > 12 或字符 > 10000 时触发，一次性重写为"省略标记 + 最近两轮"。逐轮丢最旧一条会让前缀每轮都变，缓存永远不命中；低频压缩是唯一允许的重建点。

**Q61 ★★ 工具调用轮如何保持追加式？**
A：context 固定不变；每轮只向 instruction 追加 `[助手·模型] 上轮文本`、工具结果和"继续"指令；不再重建 context。

**Q62 ★★ 为什么历史注入曾经完全失效？**
A：`currentInstruction = task.instruction || this._buildInstruction(task, history)`，而调用方总会设置 `task.instruction`，所以右侧永远不执行；`_readConversationHistory` 变成死代码。

**Q63 ★★ 讨论/辩论模式为什么不把中间阶段写进转录？**
A：评审、修订、多轮观点属于过程材料，写进去会污染下一轮聊天上下文（体积和重点都被稀释）；只记录"用户问题 + 最终答案"。

**Q64 ★★ DAG 子任务为什么不注入完整对话？**
A：保持节点隔离，避免 prompt 体积随节点数成倍膨胀；由规划器理解上下文并写出自包含的子任务指令，子任务只拿原始请求 + 直接上游输出 + 上一轮结果。

**Q65 ★★★ 如果供应商不支持前缀缓存，这套设计的代价是什么？**
A：每轮重发 6 轮/12k 字符历史，token 成本上升；好处（确定性、可审计、无进程状态）仍在。此时应下调 max_turns/max_chars 或改用摘要。

**Q66 ★★★ 如何证明缓存真的命中了？**
A：记录每轮 `prompt_hash` 与 `prefix_hash`，确认相邻轮前缀一致；从 CLI 输出/代理日志解析 usage 的 `cached_tokens` / `cache_read_input_tokens`；做固定 prompt 连续两次调用的对照实验。

**Q67 ★★ 冻结记忆与"记忆更新"如何共存？**
A：只在压缩点或新会话刷新；也可以提供"新话题/重置记忆"的手动入口。两者是新鲜度和缓存命中率的取舍。

---

## 七、Memory 机制（10 题）

**Q68 ★ 两层 Memory 分别是什么？**
A：Session Memory（`agent_memory/sessions/{taskId}/summary.md`，会话短期摘要）和 Auto Memory（`agent_memory/projects/{projectId}/MEMORY.md` + 主题文件，项目长期记忆）。

**Q69 ★★ 读取发生在什么时候？**
A：每轮 `executeSimpleTask` 开头构建 memory_context：读 MEMORY.md 索引（≤6000 字）+ 按当前输入检索最多 3 个主题（每个 ≤800 字）；改造后只在首轮生效并冻结。

**Q70 ★★ 写入发生在什么时候？**
A：每轮结束累积缓冲，超过 3 轮或 5KB 触发后台 subagent 总结；结束对话时 flush、归档到 logs、并提炼 JSON 写入 Auto Memory 主题文件。

**Q71 ★★ Session Memory 为什么不注入 prompt？**
A：它是有损、异步、可能滞后的摘要，注入会与 transcript 的完整历史重复且不一致；它的定位是"提炼长期记忆的原料"。

**Q72 ★★ 检索算法是什么？有什么弱点？**
A：按空格切关键词，元信息命中权重 2、正文权重 1，按分数和更新时间排序取前 3。弱点是中文没有空格，整句会被当成一个"词"，命中率低；也没有同义词/向量召回。

**Q73 ★★ 索引体积怎么控制？**
A：MEMORY.md 最多 200 行、25KB；超限从最旧条目开始删，保证不破坏完整条目。

**Q74 ★★★ 现在长期记忆为什么不工作？**
A：提炼只在 `terminateTask`（点"结束对话"）触发；正常关窗/切对话不触发；提炼依赖模型输出可解析 JSON，失败静默；当前项目 MEMORY.md 正文为空、无主题文件、logs 为空。

**Q75 ★★★ `appendSummary` 的实现有什么问题？**
A：它委托 `writeWorklogEntry`，在文件末尾追加一条，而不是覆盖模板正文；结果是 summary.md 里模板占位符和完整摘要并存，出现两份 `# Session Title`。真正的 `writeFull` 没有被调用。

**Q76 ★★ 归档和提炼为什么放在结束对话而不是每轮？**
A：成本（要额外调模型）和稳定性（会话未结束时摘要不完整）。代价是用户不点结束就永久丢失。

**Q77 ★★★ 如果记忆被错误写入（幻觉事实），如何防止污染后续对话？**
A：需要来源标记（哪次会话、哪条消息）、可撤销（删除主题文件 + 索引条目）、提炼时要求引用原文、读取时区分"用户偏好"与"模型推断"。当前只有 sources 字段，没有校验机制。

---

## 八、可靠性与可观测性（9 题）

**Q78 ★ 系统有哪些日志？各自用途？**
A：`logs/events/`（事件审计）、`logs/collab/`（规划/派发/结果/重试/超时/失败）、`model-logger`（每次模型请求响应、耗时、错误码）、`conversation.md`（用户可见对话）。

**Q79 ★★ 如何定位"某次执行特别慢"？**
A：先看 model-logger 的 duration 和 exit_code，再看 collab 日志的 dispatch/agent_result，区分是 CLI 启动慢、模型慢还是调度等待；最后看是否触发了 240s/300s 超时。

**Q80 ★★ 什么错误会被熔断？为什么？**
A：402 余额不足、鉴权失败、Invalid role 等致命错误；重试必然同样失败，只会白烧 token，所以直接 FAILED 并跳过该模型。

**Q81 ★★ 为什么"全部模型离线"要快速失败而不是一直等？**
A：重试没有意义；`_dispatchSubTask` 区分"有在线但未匹配到（等待）"和"全部熔断/离线（直接失败）"。

**Q82 ★★ 幂等和状态守卫各自防什么？**
A：幂等防同一消息重复消费；状态守卫防迟到回调（已超时/已取消）改变最终状态。

**Q83 ★★★ 这个系统有哪些"静默失败"？**
A：记忆提炼失败、归档失败、事件处理异常（只打日志）、工具执行失败（返回字符串给模型）、前端 fetch 失败。大部分是刻意的降级，但没有统一告警。

**Q84 ★★ 如何验证一次协作真的发生了模型间通信？**
A：看 collab 日志的 dispatch 记录是否包含 upstreamSummary（dep、模型、字符数、preview），以及子任务 prompt 里是否出现"上游任务输出"。

**Q85 ★★★ 如果要加监控指标，你会选哪些？**
A：每轮时延（排队/模型/落盘）、缓存命中率、子任务成功率与重试次数、超时率、模型熔断数、失败导致的挂起请求数、记忆写入成功率。

**Q86 ★★ 前端如何避免"旧响应覆盖新状态"？**
A：请求序号 + 对话长度单调性校验（conversation.md 只追加，更短的快照丢弃）+ 当前任务校验，三者叠加。

---

## 九、安全（6 题）

**Q87 ★★ `--permission-mode bypassPermissions --add-dir ROOT` 的风险？**
A：模型 CLI 拥有项目目录的读写权限且跳过确认；如果 prompt 被注入（比如工具结果里藏指令），可能读写任意项目文件。应限制目录、只读挂载、或对工具结果做隔离。

**Q88 ★★ 黑板 Key 如何防路径穿越？**
A：`_safeKey` 替换路径分隔符并禁止 `..` 片段，Key 最终映射为文件名。

**Q89 ★★★ prompt injection 在这个系统里的攻击面有哪些？**
A：工具返回值、上游子任务输出、用户输入文件内容都会进入 prompt。下游模型无法区分"数据"和"指令"。缓解要靠结构化分隔、权限最小化、输出校验，而不是只靠提示词。

**Q90 ★★ 密钥管理的教训？**
A：项目曾把 `config/api_keys.yaml` 提交进 git，且仓库公开；应把密钥移出版本控制、使用环境变量/密钥管理服务、轮换历史泄露的 key，并开启 secret scanning。

**Q91 ★★ 多用户/多租户隔离靠什么？**
A：按 task_id 隔离目录和 Session；删除有 owner/admin 校验。但没有进程级或网络级隔离，CLI 共享同一个 HOME 和项目目录。

**Q92 ★★★ 如果同机运行不可信代码（模型生成的代码），如何隔离？**
A：至少独立容器/用户、只读挂载、网络白名单、资源限额；当前 `cwd=ROOT` + bypass 权限不满足隔离要求。

---

## 十、测试与工程化（7 题）

**Q93 ★ 如何测试"上下文确实带上了上一轮"？**
A：stub 掉 adapter 捕获 input，断言第二轮 prompt 以第一轮为前缀、包含上一轮回复和当前问题；这是 `tests/prompt-context.test.js` 的做法。

**Q94 ★★ 为什么测试脚本必须手动 `config.loadAll()`？**
A：`config.agents` 等字段只在服务启动时加载，测试直接 require 模块时为空，导致模型列表、上下文配置都拿不到默认值。

**Q95 ★★ stub 适配器有什么风险？**
A：可能绕过真实校验。项目踩过：stub 了 runtime 却没复刻 `validateUnifiedInput`，中文 role 被真实适配器全部拒绝而测试通过。教训是 stub 要复刻关键校验。

**Q96 ★★ 如何测试 DAG 的失败级联？**
A：构造"中间节点必失败"的子任务，断言下游变 SKIPPED 且顶层 Promise 能 resolve/reject——当前实现没有 SKIPPED，测试会暴露挂起问题。

**Q97 ★★ 沙箱测试的局限？**
A：无浏览器、无真实模型登录，只能测后端链路和用 stub；流式、缓存命中、CLI 超时行为都要本地验证。

**Q98 ★★ 如何做缓存命中的自动化回归？**
A：固定 prompt 连续调用两次，解析 usage 的 cached 字段，断言第二次 > 0；再叠加多轮历史，观察衰减点。

**Q99 ★★★ 这个项目最需要补的测试是什么？**
A：调度器状态机的性质测试（任意事件顺序不导致非法终态/挂起）、取消的竞态测试、记忆的幂等与污染测试、prompt 前缀不变量测试（已有）。

---

## 十一、扩展性与重构（6 题）

**Q100 ★★ 新增一个模型需要改哪些地方？**
A：新增 adapter（实现 execute/healthCheck/流式解析）+ agents.yaml 配置 + runtime `_createAdapter` 映射 + AGENT_IDS/AGENT_NAMES + 前端模型名映射；skill 与调度无需改。

**Q101 ★★ 新增一个协作模式需要改什么？**
A：orchestrator 路由分支 + 模式实现（可复用 `_callAgentRaw` / `_discRound`）+ 前端模式开关 + 事件与对话落盘；如果参与 DAG，还要在 planner 提示词和事件类型里登记。

**Q102 ★★★ 黑板从文件换 Redis，哪些语义要保留？**
A：TTL 惰性过期、Hash 字段、幂等 SETNX、键空间隔离（trace/sub/running）；同时要把 `keys(prefix)` 扫描换成索引集合，避免生产环境 KEYS 阻塞。

**Q103 ★★★ 事件总线换成 Kafka/RabbitMQ 需要处理什么？**
A：消费组与分区（按 trace_id 保证顺序）、ack 与重投、死信、幂等、事件版控制和 schema 演进；完成事件要从"通知"升级为"状态变更事件"。

**Q104 ★★ 如何把上下文机制推广到多机？**
A：transcript 存对象存储/数据库并按 task_id 分区；prompt 组装保持纯函数；缓存前缀哈希与供应商缓存策略绑定，跨节点也要一致。

**Q105 ★★★ 系统里哪些地方最容易随时间腐化？**
A：对话/记忆的多处写入（conversation、transcript、summary、logs）容易不一致；事件常量与实现脱节；拆分文件带来的隐式依赖。需要单一事件源 + 生成式视图来收敛。

---

## 十二、行为与反思（7 题）

**Q106 ★ 这个项目里最难排查的 bug 是什么？**
A：多轮/多对话下"输出先消失后重现"——由 done 气泡无条件删除、fetch 乱序、切换对话串扰叠加造成。定位靠逐层排除：先确认服务端落盘时序，再查前端状态覆盖，最后用序号 + 单调性 + activeId 三重防护。

**Q107 ★★ 你踩过哪些"看起来是模型问题、实际是代码问题"的坑？**
A：① 适配器 `_runCli` 里引用不存在的 `input` 导致全部模型离线；② 进程注册用子任务 ID、停止用对话 ID 导致杀不掉；③ 拆文件后裸标识符缺失导致子任务卡 PENDING。

**Q108 ★★ 你如何决定"降级"还是"报错"？**
A：以"用户能否继续"为准：记忆、归档、日志失败一律降级；规划解析失败降级默认 DAG；致命鉴权/余额错误直接失败并熔断，避免无意义重试。

**Q109 ★★ 如果产品要求"对话必须记得所有内容"，你怎么答复？**
A：说明上下文窗口和成本约束，给出分级方案：最近 N 轮原文 + 早期摘要 + 关键事实抽取；并明确"记得"的验收方式（指代消解测试集）。

**Q110 ★★★ 你如何证明一个多 Agent 系统比单 Agent 更好？**
A：设计对照实验：同任务、同模型预算，比较正确率、时延、成本、失败恢复；按任务类型分层（创作、代码、评审）。如果只在"多模型讨论"上略好但成本翻倍，要如实说明。

**Q111 ★★ 这个项目里你最想删掉的一段代码？**
A：未使用的 `_readConversationHistory` 和一批从未 emit 的事件常量；它们让维护者误以为系统有依赖就绪事件和日志反推历史的能力。

**Q112 ★★★ 如果给你两周，你会优先做哪三件事？**
A：① 修 DAG 失败级联（SKIPPED）并加状态机测试；② 把记忆写入改成真正覆盖 + 扩展触发时机；③ 加缓存命中与关键路径指标，用数据验证上下文改造的效果。

---

## 附：快速追问清单

- "你说的前缀缓存，命中率是多少？怎么测的？"
- "中间节点失败后，请求会返回吗？"
- "同一模型并发两个对话，进程和状态怎么隔离？"
- "取消发生在 await 期间，会发生什么？"
- "记忆里的内容是模型写的，你怎么知道它是对的？"
- "这套设计在 10 个并发对话下会先坏在哪？"
- "如果把 scheduler 拆成独立服务，哪些接口要变？"
- "prompt 里哪些内容是每轮都变的？为什么它们必须在尾部？"
