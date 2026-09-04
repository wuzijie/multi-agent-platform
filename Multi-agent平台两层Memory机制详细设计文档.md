# Multi-agent 平台两层 Memory 机制详细设计文档

## 1. 文档综述

为解决 Multi-agent 系统的上下文丢失、记忆冲突和跨会话知识沉淀问题，本文档基于行业主流架构设计，为 Multi-agent 平台定义一套生产级的两层 Memory 机制，涵盖会话级的 Session Memory 与项目级持久化的 Auto Memory。本设计采用 “分而治之” 的策略，按作用域拆分存储、统一底层技术规范，为多智能体协作提供清晰的上下文隔离与沉淀能力。

### 1.1 背景与目标

在 Multi-agent 系统的实际运行中，单一的上下文存储机制会导致严重的工程问题：一是会话间记忆隔离性不足，出现交叉污染；二是会话结束后有效上下文无法留存，跨会话任务无状态可复用；三是长期记忆检索成本高、更新效率低；四是缺乏标准化的持久化方案，上下文容易丢失[(2)](https://blog.csdn.net/u014419174/article/details/152412478)。

本设计的核心目标如下：



* 隔离性：实现会话、项目、团队级的记忆隔离，避免冲突污染

* 持久性：保障长期记忆的可靠落盘，支持跨会话、任务复用

* 可检索性：建立分层索引机制，优化记忆检索效率

* 可扩展性：采用无状态存储协议，支撑水平扩展与多部署形态

* 性能：分层控制记忆存储粒度，将检索时延与 Token 开销控制在合理水平[(3)](https://www.cnblogs.com/AmazonwebService/p/19868921)

### 1.2 核心设计原则

本设计遵循四项核心技术原则，确保记忆机制的稳定性与工程落地性：



1. **目录隔离原则**：按记忆类型、作用域拆分目录，通过文件系统的天然隔离能力，实现不同会话、项目、团队的记忆存储隔离，从底层避免记忆交叉污染[(56)](https://juejin.cn/post/7611383061968601134)。

2. **索引与正文分离原则**：全局索引文件仅存储元信息与内容指针，不留存具体记忆正文；详细内容拆分独立文件存储，控制索引体积，保障检索效率[(28)](https://www.phppan.com/2026/03/)。

3. **Markdown+Frontmatter 统一存储原则**：所有记忆内容采用 Markdown 格式存储，方便人工阅读和编辑；所有文件头部附加 YAML frontmatter 元信息，给机器检索提供标准化标识，不需要额外搭建数据库或专用存储引擎[(32)](https://www.smallyoung.cn/docs/018-Claude_Code%E8%AE%B0%E5%BF%86%E7%B3%BB%E7%BB%9F%E6%B7%B1%E5%BA%A6%E5%88%86%E6%9E%90)。

4. **分层作用域原则**：记忆按会话、项目、团队分层存储，各层遵循 “不上浮、不下沉” 的隔离规则 —— 会话级数据不能留存到项目级，项目级数据不能混入会话级，确保记忆的生命周期与所属主体强绑定[(2)](https://blog.csdn.net/u014419174/article/details/152412478)。

### 1.3 术语定义



| 术语     | 英文缩写                    | 定义                                                       |
| ------ | ----------------------- | -------------------------------------------------------- |
| 会话记忆   | Session Memory          | 对应单轮用户交互会话的短期记忆，存储当前会话的交互中间状态与上下文摘要，会话结束后或摘要持久化后即失效      |
| 自动记忆   | Auto Memory             | 跨会话留存的项目级长期记忆，存储用户偏好、项目规则、核心结论等不随会话销毁的有效知识               |
| 团队记忆   | Team Memory             | Auto Memory 的扩展层，将项目级长期记忆同步到团队共享空间，允许同一团队成员的 Agent 跨节点复用 |
| 会话标识符  | Session ID              | 标识唯一用户交互会话的字符串                                           |
| 项目标识符  | Project ID              | 标识唯一项目的字符串，通常与代码库根目录的哈希值或唯一名称对应                          |
| 压缩阈值   | Compaction Threshold    | 触发上下文摘要压缩的条件，一般以对话上下文的 Token 占用量为衡量标准                    |
| 后台提取服务 | ExtractMemories Service | 主会话响应完成后，异步提炼有效长期记忆并写入 Auto Memory 的后台任务                 |

### 1.4 设计范围与依赖边界

#### 1.4.1 设计范围

本设计文档覆盖 Multi-agent 平台两层 Memory 机制的以下核心内容：



* 统一存储结构的目录布局、索引格式、内容文件规范

* Session Memory 的存储形式、写入 / 读取规则、生命周期管理

* Auto Memory 的存储结构、写入 / 读取时机、长期沉淀逻辑

* 两层记忆的交互协作流程

* 记忆检索匹配的通用规则

#### 1.4.2 依赖边界

本设计的技术实现，依赖 Multi-agent 平台的以下基础能力支撑：



* 平台提供全局唯一的 Session ID、Project ID 生成与溯源能力

* 平台的上下文管理模块，支持在会话生命周期内加载、注入记忆内容

* 平台提供文件系统的读写权限，以及文件变更监听、异步任务调度的基础能力

* 平台具备大模型调用能力，可完成会话摘要压缩、长期记忆提炼的任务

* 平台的通信模块，支撑团队记忆向中心存储节点的同步传输

## 2. 统一存储结构详细设计

本机制采用统一的基于文件的存储规范，所有记忆数据均以 Markdown 格式存储，辅以 YAML frontmatter 提供元信息级的检索支撑。目录结构遵循隔离性与可扩展性要求，同时为人工编辑和机器检索提供便利。

### 2.1 核心存储规范

所有记忆文件必须严格遵循以下技术规范，保障读写一致性：



1. **编码规则**：所有文件采用 UTF-8 编码，统一使用 LF（Line Feed）作为换行符，避免跨操作系统的兼容问题[(58)](https://agents.w4w.dev/skills/catalog/custom/agent-conventions/)。

2. **文件命名规则**：文件名必须匹配小写字母、数字、连字符（-）和下划线（\_）组成的正则规则，且需与文件内`name`字段的值完全一致；索引文件固定命名为`index.md`或`MEMORY.md`，所有目录名均采用小写连字符分隔的格式[(58)](https://agents.w4w.dev/skills/catalog/custom/agent-conventions/)。

3. **存储格式组成**：每个记忆文件由两部分组成 —— 头部是 YAML frontmatter，采用`---`包裹，用于记录检索关键字段；主体是 Markdown 格式的具体内容，便于人工阅读与编辑[(32)](https://www.smallyoung.cn/docs/018-Claude_Code%E8%AE%B0%E5%BF%86%E7%B3%BB%E7%BB%9F%E6%B7%B1%E5%BA%A6%E5%88%86%E6%9E%90)。

4. **索引文件约束**：索引文件仅存储元信息和指向具体内容文件的路径指针，不留存任何详细记忆内容；其中的每个索引条目需控制在 150 字符以内，保证检索效率[(28)](https://www.phppan.com/2026/03/)。

5. **隔离模式**：底层存储采用 “单文件单记忆” 的隔离模式，每条记忆（摘要、决策、偏好、主题等）对应一个独立的 Markdown 文件；通过文件系统的目录层次，实现不同类型、不同作用域记忆的物理隔离[(56)](https://juejin.cn/post/7611383061968601134)。

### 2.2 元信息（Frontmatter）格式规范

所有记忆文件必须包含 YAML frontmatter 元信息，作为机器检索、分类校验的关键依据。元信息的所有字段均采用蛇形命名法，必须匹配下表中列出的字段类型与规则约束：



| 字段名           | 类型     | 必选   | 描述                                                                                                   |
| ------------- | ------ | ---- | ---------------------------------------------------------------------------------------------------- |
| `name`        | string | 是    | 记忆的唯一标识符，必须与文件名完全一致，仅包含小写字母、数字、连字符                                                                   |
| `title`       | string | 是    | 记忆的人类可读名称，用于索引展示和人工检索                                                                                |
| `description` | string | 是    | 记忆的简要描述，需说明其用途、适用场景和核心内容，供 Agent 检索时快速判断相关性                                                          |
| `type`        | string | 是    | 记忆的类型，限定为`session_summary`/`user_preference`/`project_context`/`decision`/`feedback`/`reference`中的一种 |
| `scope`       | string | 是    | 记忆的作用域，限定为`session`/`project`/`team`中的一种                                                             |
| `session_id`  | string | 条件必选 | 关联的会话唯一标识，仅当`scope`为`session`时必填                                                                     |
| `project_id`  | string | 是    | 关联的项目唯一标识                                                                                            |
| `team_id`     | string | 条件必选 | 关联的团队唯一标识，仅当`scope`为`team`时必填                                                                        |
| `created_at`  | string | 是    | 记忆的初始创建时间，格式为 ISO8601 的 UTC 标准时间                                                                     |
| `updated_at`  | string | 是    | 记忆的最后更新时间，格式为 ISO8601 的 UTC 标准时间                                                                     |
| `agent`       | string | 否    | 关联的 Agent 名称，仅用于标识记忆的处理主体                                                                            |
| `tags`        | array  | 否    | 记忆的分类标签数组，用于辅助检索过滤                                                                                   |
| `sources`     | array  | 否    | 记忆的原始来源文件路径数组，用于溯源                                                                                   |

元信息的模板格式如下：



```
\---

name: "string"

title: "string"

description: "string"

type: "session\_summary | user\_preference | project\_context | decision | feedback | reference"

scope: "session | project | team"

session\_id: "string"

project\_id: "string"

team\_id: "string"

created\_at: "YYYY-MM-DDTHH:MM:SSZ"

updated\_at: "YYYY-MM-DDTHH:MM:SSZ"

agent: "string"

tags: \["array", "string"]

sources: \["array", "string"]

\---
```

### 2.3 全局目录结构设计

整个记忆系统的根目录为`agent_memory/`，所有记忆内容按作用域的分层隔离要求，采用三级目录结构存储，整体布局如下：



```
agent\_memory/

├── sessions/ # Session Memory根目录（作用域=session）

│   └── {session\_id}/ # 单个会话的所有记忆文件目录

│       ├── summary.md # 会话完整摘要，为该目录下的主索引文件

│       ├── incremental/ # 会话增量摘要存储目录

│       │   ├── 2026-08-01T14-30-00.md

│       │   └── 2026-08-01T14-35-00.md

│       └── artifacts/ # 会话运行时产生的临时产物存储目录

└── projects/ # Auto Memory根目录（作用域=project/team）

&#x20;   └── {project\_id}/ # 单个项目的所有记忆文件目录

&#x20;       ├── MEMORY.md # Auto Memory的核心全局索引文件

&#x20;       ├── user\_role.md # 项目级用户偏好主题文件

&#x20;       ├── feedback\_testing.md # 项目级反馈记录主题文件

&#x20;       ├── project\_auth\_rewrite.md # 项目级决策记录主题文件

&#x20;       ├── reference\_dashboards.md # 项目级参考信息主题文件

&#x20;       ├── ... # 其他项目级记忆主题文件

&#x20;       ├── logs/ # 项目级历史日志存储目录

&#x20;       │   └── 2026/

&#x20;       │       └── 08/

&#x20;       │           └── 2026-08-01.md

&#x20;       └── team/ # Team Memory根目录（作用域=team）

&#x20;           ├── MEMORY.md # Team Memory的核心全局索引文件

&#x20;           ├── feedback\_db\_tests.md # 团队级共享记忆主题文件

&#x20;           └── reference\_linear.md # 团队级共享记忆主题文件
```

该结构遵循行业标准的隔离规范，设计要点完全匹配 Multi-agent 系统的分层隔离需求：



* `sessions/`目录下的所有会话目录，仅留存作用域为`session`的短期记忆，会话销毁后其下的记忆将按策略清理

* `projects/`目录下的所有项目目录，仅留存作用域为`project`或`team`的长期记忆，所有跨会话的全局记忆内容统一存储在此目录下

* 同一项目的所有 Team Memory，统一存放在`team/`子目录下，由平台的文件同步服务统一进行多节点分发

* 所有目录下的索引文件（`summary.md`、`MEMORY.md`），均遵循 “索引与正文分离” 的原则，仅存储元信息和内容文件引用

* 会话级、项目级、团队级的记忆文件完全隔离，不存在任何交叉存储的情况[(56)](https://juejin.cn/post/7611383061968601134)。

## 3. Session Memory 详细设计

Session Memory 是 Multi-agent 系统的短期工作记忆，为当前活跃会话提供隔离的上下文存储，是 Agent 进行多轮推理的直接上下文来源。

### 3.1 定义与用途

Session Memory 的核心用途，是为 Multi-agent 系统提供会话级的上下文隔离，保证不同会话之间的记忆不会相互干扰 —— 它相当于当前会话的 “工作记忆缓冲区”，留存用户与 Agent 交互的完整中间状态，包括业务数据、执行结果、操作历史和多轮对话的上下文摘要。

作为实时推理的主上下文来源，Session Memory 需要被频繁读取。为了将检索时延控制在合理水平，记忆内容会被平台优先加载到内存中，不会长期留存在底层存储，这也符合会话级数据的生命周期特性[(1)](http://m.toutiao.com/group/7673318880072270355/)。

具体而言，Session Memory 承担以下三个核心职能：



1. 实时工作缓冲区：存放当前会话活跃上下文，供 Agent 在多轮推理时直接快速调用

2. 短期摘要持久化载体：以增量 / 全量的形式，将会话上下文摘要落盘存储，作为长期记忆的原始数据来源

3. 会话隔离屏障：通过会话级目录隔离不同会话的上下文数据，从存储层避免记忆污染

### 3.2 存储形式

Session Memory 以会话为单位，组织存储文件，每个会话对应独立的`{session_id}`子目录，目录内的文件结构完全统一。

#### 3.2.1 文件结构

Session Memory 的存储文件，遵循 “摘要 + 增量 + 产物” 的组合模式，单个会话的目录结构如下：



```
{session\_id}/

├── summary.md # 会话完整摘要（主索引，增量写入）

├── incremental/ # 增量摘要存储目录

│   ├── 2026-08-01T14-30-00.md

│   └── 2026-08-01T14-35-00.md

└── artifacts/ # 会话运行时产物存储目录
```

各部分的存储逻辑与约束，完全匹配 Multi-agent 系统的短期记忆留存要求：



* `summary.md`是 Session Memory 的核心文件，集中存储该会话的所有增量摘要合并后的完整内容；它采用追加式写入策略，不会覆盖原有内容，便于会话恢复时一次性读取完整上下文[(21)](https://blog.csdn.net/qq_38723677/article/details/161666169)。

* `incremental/`目录下，按时间戳命名的文件（精度到毫秒、保证不重复），存储每轮对话后的增量式摘要 —— 这些文件作为`summary.md`的增量补充内容，遵循 “写入后永不修改” 的追加式 rule，可在会话异常时恢复数据。

* `artifacts/`目录存放会话运行时产生的临时产物，比如工具调用的结果、大模型的原始输出、格式化的中间数据文件等；这些产物仅为当前会话服务，不参与长期记忆的提炼。

#### 3.2.2 格式规范

Session Memory 的所有文件，必须遵循统一的技术规范，保障写入 / 读取的兼容性：



* 所有文件必须采用 “Markdown 内容 + YAML frontmatter” 的组合格式，其中 YAML frontmatter 的必填字段，需要完全匹配本文档的 2.2 节规范

* `summary.md`文件的`type`字段，固定为`session_summary`；`incremental/`目录下的所有文件，`type`字段固定为`incremental_session_summary`

* `artifacts/`目录下的产物文件，格式可以为 JSON、XML、Plaintext 等任意格式；但如果是 Markdown 格式的文件，必须附加符合规范的 YAML frontmatter，便于溯源和检索

* 所有文件的`scope`字段，必须固定为`session`；`session_id`字段，必须与所属目录的会话标识号完全一致[(21)](https://blog.csdn.net/qq_38723677/article/details/161666169)

### 3.3 写入方式

Session Memory 的写入，由会话的生命周期事件或上下文压缩阈值触发，将内存中的上下文摘要，以同步或异步的方式落盘存储。所有文件采用 “追加式写入” 的不可变策略，即内容写入文件后不会被修改，新的内容只会追加到文件末尾，或者写入到新的增量文件中；这种设计，能最大程度避免数据丢失，保障上下文的完整性[(35)](https://docs.swarms.world/agents/agent-memory)。

#### 3.3.1 触发条件

Session Memory 的写入触发条件，与会话的核心生命周期节点绑定，确保关键上下文及时落盘，具体分为三类：



| 触发条件      | 触发时机                                   | 写入模式      | 目标文件                                   |
| --------- | -------------------------------------- | --------- | -------------------------------------- |
| 每轮对话结束    | 平台向用户返回响应结果后                           | 异步增量写入    | `incremental/`目录下的新文件，以及`summary.md`   |
| 上下文压缩阈值触发 | 对话上下文的 Token 占用量达到预设阈值，且当前没有正在处理的工具调用时 | 同步完整摘要写入  | `summary.md`                           |
| 会话正常终止    | 用户主动结束会话、或会话超时被平台回收时                   | 同步全量持久化写入 | `summary.md`，以及项目级 Auto Memory 的临时日志文件 |

#### 3.3.2 写入逻辑

针对不同的触发条件，Session Memory 采用差异化的写入逻辑，平衡写入性能、上下文完整性和检索效率：



1. **增量摘要写入逻辑**：每轮对话结束后，平台的异步线程会将该轮的上下文摘要，写入`incremental/`目录下的新文件；随后将这条摘要，追加到`summary.md`文件末尾。该过程不会阻塞主响应线程，增量摘要的内容，会被后续的完整摘要压缩合并进去[(35)](https://docs.swarms.world/agents/agent-memory)。

2. **完整摘要写入逻辑**：当上下文的 Token 占用量达到压缩阈值（默认是模型上下文窗口的 90%），或者距离上次压缩后的新对话轮次达到预设值时，会触发完整摘要写入：平台的压缩线程会读取该会话`incremental/`目录下的所有增量文件，将所有增量摘要和历史完整摘要，合并提炼为一篇新的完整摘要，覆盖写入`summary.md`文件；完成写入后，系统会根据配置，决定是否清理`incremental/`目录下的旧增量文件[(51)](https://blog.csdn.net/qq_43437874/article/details/162078295)。

3. **全量持久化写入逻辑**：会话正常终止时，平台会先将最新的完整摘要，追加到`summary.md`文件末尾；随后将`summary.md`的内容，同步到对应项目的`logs/`目录下，作为长期记忆的原始数据来源；若会话异常终止，平台会在进程退出前的超时时间内，尝试将当前的完整摘要，写入到`summary.md`文件中，尽量减少未持久化的上下文损失[(55)](https://github.com/beena-yatin-kanyal/agentic-documentation/blob/master/part-2-memory-and-context-management.md)。

#### 3.3.3 压缩阈值与策略

上下文压缩是控制 Session Memory 体积、优化长期记忆检索效率的核心手段。压缩阈值的触发条件，默认采用行业通用的标准化配置，同时支持平台侧的自定义调整：



* 阈值配置：系统会优先采用项目配置文件中的自定义阈值参数；如果未配置，会默认采用模型上下文窗口的 90% 作为触发阈值，比如上下文窗口为 8000Token 的模型，在上下文占用量达到 7200Token 时触发压缩[(52)](https://juejin.cn/post/7615250753898545215)。

* 压缩逻辑：压缩线程会保留最新的 N 轮完整对话原文 —— 这里的 N 可在平台的全局配置中，根据成本预算和性能要求调整；将其余更早的历史对话内容，调用大模型提炼为不超过预设长度的极简摘要，用摘要替换原有完整对话，将上下文总长度控制在合理范围内[(40)](https://cloud.tencent.com/developer/article/2699038)。

* 压缩触发时机：压缩操作必须在模型完成响应、且没有待处理工具调用的空闲状态下执行；压缩完成并将新摘要写入文件后，系统才会更新内存中的上下文指针，确保新的读请求能读取到最新的摘要内容[(51)](https://blog.csdn.net/qq_43437874/article/details/162078295)。

### 3.4 读取方式

Session Memory 的读取，由会话的生命周期节点触发，将磁盘中的摘要文件内容，加载到内存或上下文管理器中。读取设计遵循 “always load the latest complete summary” 的核心原则，保障 Agent 推理时，能获取到完整、连续的上下文信息[(34)](https://www.cnblogs.com/alisystemsoftware/p/20084018)。

#### 3.4.1 触发条件

Session Memory 的读取触发条件，与会话的启动、恢复流程强绑定，确保关键上下文被提前加载到内存，具体分为两类：



| 触发条件      | 触发时机                     | 读取模式     | 目标文件                                      |
| --------- | ------------------------ | -------- | ----------------------------------------- |
| 会话启动 / 恢复 | 使用相同的`Session ID`重新发起会话时 | 增量加载摘要索引 | `summary.md`文件，以及`incremental/`目录下的所有增量文件 |
| 上下文压缩完成后  | 压缩线程完成新摘要写入后             | 完整摘要读取注入 | `summary.md`文件                            |

#### 3.4.2 读取逻辑

针对不同的触发条件，Session Memory 的读取逻辑，需要严格匹配写入逻辑的优先级，保证加载的上下文完整性：



1. **会话启动时读取逻辑**：平台的上下文管理器会优先读取`summary.md`文件，将其中的完整摘要内容加载到内存中；随后读取`incremental/`目录下的所有增量文件，按时间戳顺序追加到完整摘要的内存实例中；接着将合并后的完整上下文，注入到 Agent 的推理上下文窗口中；如果文件读取失败，平台会自动回退到上一个可用的摘要版本，确保会话能正常启动[(34)](https://www.cnblogs.com/alisystemsoftware/p/20084018)。

2. **上下文压缩后读取逻辑**：压缩完成后，平台的上下文管理器会重新读取`summary.md`文件的最新完整摘要，替换内存中的原有上下文实例；读取完成后，系统会主动清理该会话在内存中的原有上下文实例，避免新旧上下文冲突；后续的所有推理请求，都会基于新的完整摘要进行[(51)](https://blog.csdn.net/qq_43437874/article/details/162078295)。

#### 3.4.3 读取优先级

为了保证读取性能，Session Memory 的读取，需要遵循 “内存优先、磁盘兜底” 的优先级策略：



1. 会话启动时，平台会优先从内存中加载该 Session 的上下文；

2. 如果内存中不存在，才会从磁盘中读取`summary.md`文件；

3. 若`summary.md`文件不存在或已损坏，系统会按时间戳倒序读取`incremental/`目录下的增量文件，合并恢复出尽可能完整的会话上下文；

4. 若增量文件也不存在，系统会自动回退到上一个可用的完整摘要，或者根据用户的历史会话记录重建部分上下文；

5. 若所有上级节点都无法命中，系统会重建一个空的上下文，保证会话正常发起[(33)](https://www.51cto.com/article/854121.html)。

### 3.5 生命周期管理

Session Memory 的生命周期与会话强绑定，从会话创建时启动，到会话终止后销毁或归档，完全遵循 “按需创建、用毕即释放” 的原则。其生命周期管理逻辑，由平台的会话管理器统一负责，严格按淘汰策略执行，避免磁盘空间被无效数据占用：



* 创建：会话管理器接收到用户的会话创建请求后，会在磁盘上创建对应的`{session_id}`目录和子目录，初始化`summary.md`文件，写入基础的元信息；

* 维护：会话活跃期间，会话管理器会根据写入逻辑，按需更新摘要文件或增量文件；

* 销毁：会话终止后，会话管理器会启动一个延迟回收线程，根据全局配置的保留时长，将过期的会话目录标记为可清理；在系统的磁盘空闲窗口，或达到磁盘占用阈值时，会统一清理所有过期会话目录下的临时产物和增量摘要文件；

* 归档：若会话的摘要内容有长期留存价值，会在清理前，将`summary.md`文件的内容，提炼后追加到 Auto Memory 的项目级日志文件中，保证关键上下文不会被遗漏[(1)](http://m.toutiao.com/group/7673318880072270355/)。

## 4. Auto Memory 详细设计

Auto Memory 是 Multi-agent 系统的核心长期记忆层，负责跨会话、跨任务留存项目级的有效知识，是 Agent 在新会话中获取历史项目上下文、用户偏好的核心来源。

### 4.1 定义与用途

Auto Memory 存储经过提炼、有长期留存价值的项目级记忆，比如用户的业务偏好、项目的核心决策结论、项目架构说明、线上故障排障 SOP、外部系统访问指针等。这些内容不会随着会话的结束而销毁，而是长期留存在存储介质中，供后续会话的 Agent 检索复用[(4)](https://developer.microsoft.com/blog/designing-multi-agent-intelligence)。

Auto Memory 的核心设计目标，是解决 Session Memory 的上下文生命周期限制问题 —— 它留存的信息，是 Session Memory 无法留存但对后续任务关键的内容，且这些信息无法从项目的代码库、配置文件等其他来源推导得出，因此需要在会话之间进行持久化留存[(44)](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)。

具体而言，Auto Memory 承担以下三个核心职能：



1. 跨会话上下文存储：留存项目级的全局上下文数据，供同一项目的不同会话、不同 Agent 检索复用

2. 跨会话知识沉淀：留存经过验证的有效知识、决策结论，比如项目的技术选型结论、业务规则、部署流程等

3. 跨会话行为修正：留存历史交互中的行为反馈，比如用户对回复风格的要求、系统操作的约束、错误的处理逻辑等，作为后续 Agent 行为的参考依据[(3)](https://www.cnblogs.com/AmazonwebService/p/19868921)。

### 4.2 存储结构

Auto Memory 采用 “一个核心索引文件 + 多个独立主题内容文件” 的两级存储结构 —— 这是行业内用于解决长期记忆 “检索效率” 和 “内容可扩展性” 矛盾的标准设计，既保证了检索效率，又支持记忆内容的无界扩展[(42)](https://lobehub.com/skills/agoodboywlb-pensieve-obsidian-skill-obsidian-note)。

#### 4.2.1 第一级：核心索引文件

每个项目的记忆目录下，必须有且仅有一个名为`MEMORY.md`的核心索引文件，作为 Auto Memory 检索的唯一入口。这个文件会被加载到 Agent 的上下文窗口中，是 Agent 定位具体记忆内容文件的关键依据[(44)](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)。

`MEMORY.md`的设计规则，需要严格控制其体积，避免占用水槽上下文窗口的宝贵空间：



* 职能定位：它是 Auto Memory 的全局索引，不存储任何具体的记忆内容，仅留存指向主题文件的指针和元信息；

* 内容格式：每一行对应一个主题记忆文件的索引条目，条目格式为`[主题名称](主题文件名.md) — 主题内容的简要描述`；

* 大小限制：文件行数不能超过 200 行，体积不能超过 25000 字节；若同时超出两个阈值，会按行截断，且截断时不会破坏完整条目，保证索引的有效性[(44)](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)；

* 加载规则：会话启动时，平台会优先将`MEMORY.md`文件的内容，加载到 Agent 的上下文窗口中；后续 Agent 会根据这个索引的指针，按需读取具体的主题文件内容[(42)](https://lobehub.com/skills/agoodboywlb-pensieve-obsidian-skill-obsidian-note)。

#### 4.2.2 第二级：独立主题内容文件

与核心索引文件同目录的，是具体的主题内容文件。每个文件存储一个独立的主题记忆，采用 “单文件单主题” 的设计，避免不同主题的记忆内容耦合，影响检索效率[(44)](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)。

主题文件的设计规则，需要遵循以下行业标准的约束，保证存储的一致性和可检索性：



* 内容组织：按记忆的主题类型拆分，不同类型的记忆，必须存放在不同的文件中；

* 命名规则：采用小写连字符的格式，且必须与文件内的`name`元信息字段严格匹配，保证索引指针的定位精度；

* 格式规范：文件必须附带 YAML frontmatter 元信息，且`scope`字段必须设置为`project`或`team`，`project_id`字段必须与所属项目目录的标识完全一致；

* 目录隔离：项目级的主题文件直接存放在项目记忆目录下，不嵌套额外的子目录；团队级的主题文件，统一存放在`team/`子目录下；

* 引用规则：主题文件之间允许相互引用，但必须采用相对路径，且需要在被引用文件的`sources`元信息字段中记录来源，保证溯源的准确性[(56)](https://juejin.cn/post/7611383061968601134)。

#### 4.2.3 补充目录结构

为了存储历史日志及团队共享记忆，Auto Memory 在两级存储结构的基础上，补充了两个子目录，形成完整的存储布局：



```
{project\_id}/

├── MEMORY.md # 核心索引文件

├── user\_role.md # 项目级主题文件

├── ... # 其他项目级主题文件

├── logs/ # 历史日志存储目录

│   └── 2026/

│       └── 08/

│           └── 2026-08-01.md

└── team/ # 团队级记忆存储目录

&#x20;   ├── MEMORY.md # 团队级索引文件

&#x20;   └── ... # 团队级主题文件
```

补充目录的存储规则，需要匹配不同类型记忆的访问频率和备份要求：



* `logs/`目录：按年、月组织三级子目录，存储从 Session Memory 持久化同步过来的会话级日志文件，作为沉淀长期记忆的原始数据来源；

* `team/`子目录：存储团队级共享的记忆文件，其结构与项目级完全一致，也包含独立的`MEMORY.md`核心索引文件；

* 两个补充目录下的所有文件，同样需要遵循 “Markdown 内容 + YAML frontmatter” 的格式规范，保证检索和同步的一致性[(44)](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)。

### 4.3 写入时机

Auto Memory 的写入由两类主体触发，两类主体互斥，且不会在同一轮次内同时执行，避免对同一文件的并发写操作，导致数据不一致。

#### 4.3.1 主会话 Agent 主动写入

在会话过程中，如果主会话 Agent 通过上下文推理，或接收到用户的显式指令，认为某条会话上下文信息需要长期留存，会直接将该条信息写入到对应项目的 Auto Memory 目录下的新主题文件中；随后在`MEMORY.md`核心索引文件中，追加指向该新主题文件的指针条目[(44)](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)。

这类写入操作的优先级高于后台提取服务的补充写入操作，执行完成后，后台服务会跳过对该部分会话内容的处理，避免重复写入。

#### 4.3.2 后台 extractMemories 服务补漏写入

这是 Auto Memory 的次要写入时机，由平台的后台异步任务处理，作为 Agent 主动写入的补充，用于提炼那些会话过程中没有被 Agent 主动捕捉到、但仍然有长期留存价值的会话级信息[(44)](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)。

后台服务的执行逻辑，需要与主会话的写入流程隔离，避免阻塞主会话响应或产生并发写冲突，流程细节如下：



1. 触发时机：在主会话 Agent 完成对用户的响应、且没有待处理工具调用的空闲状态下，由平台的后台调度器触发执行；

2. 执行规则：后台服务是主会话的完整镜像，会复用主会话的上下文缓存，保证处理过程的 Token 开销不会额外增加；

3. 处理流程：读取 Session Memory 的会话摘要内容，提炼出需要长期留存的信息，写入到新的主题文件中，并在`MEMORY.md`索引文件中追加对应的指针条目；

4. 调度逻辑：后台服务会在连续的主会话空闲时间段内，按顺序处理待提炼的会话内容；如果上一次后台处理未完成，新的后台触发会将会话上下文暂存，待当前处理完成后再执行补充提取；

5. 互斥规则：后台服务会检测主会话 Agent 是否在本轮次中已经写入过记忆文件；如果已写入，则跳过该轮次的对应会话内容处理，避免重复写入；

6. 超时控制：在会话终止、或进程关闭前，平台会等待后台服务的处理任务执行完成；如果超过预设的超时时间，会强制中断后台任务，避免资源长时间占用[(44)](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)。

### 4.4 读取时机

Auto Memory 的读取，由会话的生命周期节点或用户请求的任务类型触发，将磁盘中的记忆文件内容加载到内存或上下文管理器中。读取采用 “两级索引定位” 的策略，先加载索引、再按需加载具体主题内容，平衡上下文完整性和检索性能，避免占用过多的上下文窗口。

#### 4.4.1 触发条件

Auto Memory 的读取触发条件，与会话的启动流程、任务的执行特征强绑定，确保将有效的长期记忆提前注入到 Agent 上下文中，具体分为两类：



| 触发条件 | 触发时机                  | 读取模式   | 目标文件                  |
| ---- | --------------------- | ------ | --------------------- |
| 会话启动 | 会话初始化、或从异常状态恢复时       | 加载基础索引 | 项目级的`MEMORY.md`核心索引文件 |
| 任务执行 | Agent 接收用户任务、或开始工具调用时 | 按需检索加载 | 与当前任务上下文相关的具体主题记忆文件   |

#### 4.4.2 读取逻辑

针对不同的触发条件，Auto Memory 的读取逻辑，需要按 “先定位、后检索、再注入” 的顺序执行，最大化检索性能，减少无效内容的加载：



1. **会话启动时读取逻辑**：Agent 会首先读取项目级的`MEMORY.md`核心索引文件，将其内容加载到上下文窗口中；随后解析该索引文件的内容，快速定位到与当前会话上下文、用户任务相关的主题文件指针；这个过程中，不会读取任何具体的主题文件内容[(42)](https://lobehub.com/skills/agoodboywlb-pensieve-obsidian-skill-obsidian-note)。

2. **任务执行时读取逻辑**：根据会话启动时定位到的主题文件指针，Agent 检索相关的主题文件内容，将其注入到推理上下文窗口中；具体的检索过程，需要按照本文档第 5 章的 “记忆检索匹配机制” 规则执行[(42)](https://lobehub.com/skills/agoodboywlb-pensieve-obsidian-skill-obsidian-note)。

#### 4.4.3 按需加载策略

为了避免记忆内容占满 Agent 的上下文窗口，Auto Memory 的读取必须采用按需加载的策略，仅加载与当前任务上下文相关的记忆内容，具体规则如下：



* 相关性筛选：系统会对检索结果集进行相关性打分，筛选出与当前任务上下文、用户输入关键词匹配度最高的记忆内容，只有得分较高的记忆内容才会被加载；

* 数量限制：单次任务执行过程中，加载的主题文件数量不能超过平台的全局配置阈值，避免上下文窗口被过多的记忆内容占用；

* 最近使用优先：检索时会优先加载最近更新的记忆内容，长期未使用的记忆内容，会被降低加载优先级；

* 内存缓存命中：加载后的记忆内容，会被存入平台的共享内存缓存中，供后续同项目的会话复用；

* 上下文窗口预留：平台会在 Agent 的上下文窗口中预留一定的固定空间，用于存储 Auto Memory 的核心索引和相关记忆内容；

* 校验规则：在将记忆内容注入上下文前，系统会对检索到的记忆内容进行 existence 校验，检查记忆文件是否还存在；若文件不存在，会将对应的索引条目删除，自动修复无效的索引指针[(42)](https://lobehub.com/skills/agoodboywlb-pensieve-obsidian-skill-obsidian-note)。

### 4.5 生命周期管理

Auto Memory 是长期留存的记忆，其生命周期管理由平台的长期记忆管理器统一负责，不会随会话的结束而销毁。管理逻辑采用 “分层归档、按需淘汰” 的策略，控制记忆文件的总体体积，避免磁盘空间被无效记忆占用：



* 留存：记忆内容被写入后，会长期留存在存储介质中，除非触发归档或淘汰策略；

* 归档：对于超过预设保留时长、且未被任何会话检索复用的记忆内容，会被移动到`/.archive/`目录下，按统一的归档压缩策略进行压缩存储；

* 淘汰：归档后的记忆内容，会在磁盘空间占用达到阈值时，或超过预设的归档保留时长后，被平台的淘汰任务异步清理；

* 恢复：如果归档后的记忆内容，在后续会话中被检索命中，会被重新解压恢复到原目录中；

* 审计：所有的归档、淘汰和恢复操作，都会被平台记录到审计日志中，便于后续溯源；

* 同步：团队级记忆的生命周期，由团队的记忆同步服务统一管理；所有的变更操作，都会被同步到中心存储节点，保证跨节点的所有 Agent 获取一致的长期记忆内容[(56)](https://juejin.cn/post/7611383061968601134)。

## 5. 核心交互流程设计

本节定义 Session Memory 与 Auto Memory 在会话全生命周期中的协作流程，确保两层记忆的读写逻辑连贯，上下文迁移及时，数据不会重复写入。

### 5.1 会话启动流程



1. 平台的会话管理器接收到会话启动请求，根据请求参数解析出对应的`Session ID`和`Project ID`，并将这两个参数传递给记忆管理器；

2. 记忆管理器定位到 Session Memory 对应`Session ID`的目录，尝试加载`summary.md`完整摘要文件；

3. 若`summary.md`文件存在，记忆管理器会将其中的完整摘要内容，加载到 Agent 的上下文窗口中；若不存在，会读取`incremental/`目录下的所有增量摘要文件，按时间戳顺序合并为完整摘要，再注入到 Agent 的上下文窗口中；

4. 随后，记忆管理器会根据`Project ID`，定位到 Auto Memory 对应项目的目录，读取`MEMORY.md`核心索引文件，将其内容加载到 Agent 的上下文窗口中；

5. Agent 根据加载的`MEMORY.md`索引内容，预定位与当前会话上下文相关的主题文件指针；

6. 若 Session Memory 加载的摘要中包含未持久化到 Auto Memory 的新增内容，记忆管理器会将该部分内容，同步到 Auto Memory 的`logs/`目录下，保证后续会话能检索到最新的上下文；

7. 会话启动完成，Agent 等待用户的任务输入。

### 5.2 对话处理流程



1. 用户输入任务请求后，Agent 会先检索已加载的 Auto Memory 核心索引文件，定位与用户输入上下文相关的主题文件指针；

2. 根据检索到的指针，记忆管理器读取对应的主题文件内容，将其注入到 Agent 的上下文窗口中；

3. 结合 Session Memory 的上下文摘要和 Auto Memory 的相关记忆内容，Agent 执行推理处理，调用所需的工具，产生响应结果；

4. 平台的记忆管理器将本轮对话的增量摘要信息，写入到 Session Memory 的`incremental/`目录下的新文件中；

5. 平台的记忆管理器将本轮对话的增量摘要信息，追加到 Session Memory 的`summary.md`文件末尾；

6. 平台将响应结果返回给用户，完成本轮对话；

7. 后台 extractMemories 服务被触发，异步处理本轮对话的内容，提炼需要长期留存的记忆，将其写入到 Auto Memory 的对应目录中；若主会话 Agent 已经主动写入了相关记忆，后台服务会跳过该轮次的内容处理。

### 5.3 上下文压缩流程



1. 平台的上下文管理器，会在每轮对话结束后，检查当前上下文的 Token 占用量，是否达到预设的压缩阈值；

2. 当达到压缩阈值时，上下文压缩流程会被触发，平台暂停接收新的对话请求；

3. 记忆管理器读取 Session Memory 的`summary.md`文件内容，以及`incremental/`目录下的所有增量摘要文件，合并为完整的会话上下文；

4. 平台调用大模型的摘要压缩接口，将完整的会话上下文，提炼为一篇简短、包含所有关键信息的新完整摘要；

5. 记忆管理器将新的完整摘要内容，覆盖写入到`summary.md`文件中；写入完成后，会根据全局配置的保留规则，清理`incremental/`目录下的所有增量摘要文件；

6. 记忆管理器重新读取更新后的`summary.md`文件内容，将其注入到 Agent 的上下文窗口中，替换原有的上下文实例；

7. 平台恢复接收新的对话请求，继续处理后续的用户输入。

### 5.4 会话终止流程



1. 用户主动发送会话终止指令，或会话超过预设的最大空闲时长被平台的会话回收机制触发时，会话终止流程启动；

2. 平台的会话管理器，将当前会话的终止状态，写入到 Session Memory 的`summary.md`文件中；

3. 记忆管理器读取`summary.md`文件的完整内容，将其同步到 Auto Memory 的`logs/`目录下，按统一的日期命名规则进行归档；

4. 后台 extractMemories 服务被触发，异步处理该会话的所有摘要内容，提炼需要长期留存的记忆，将其写入到 Auto Memory 的对应目录中；

5. 若后台 extractMemories 服务正在执行摘要提炼操作，平台会等待其执行完成；

6. 等待完成后，平台的会话管理器会销毁当前会话的上下文实例，释放内存资源；

7. 随后，会话管理器会启动延迟回收线程，根据全局配置的保留时长，将过期的会话目录标记为可清理；

8. 会话终止流程完成，所有与该会话相关的短期资源被释放。

### 5.5 后台记忆提取流程



1. 后台 extractMemories 服务，在主会话 Agent 完成响应、且没有待处理工具调用的空闲状态下，被平台的后台调度器触发启动；

2. 服务拉取当前活跃会话的上下文摘要，以及 Session Memory 中未被提炼的增量摘要内容，作为提取的数据源；

3. 服务扫描 Auto Memory 目录下的现有记忆文件，生成清单列表，其中包括文件名、更新时间、文件大小和元信息，避免提取后的内容与现有记忆产生冲突；

4. 服务调用大模型，对会话摘要内容进行分析，提炼出需要长期留存的记忆内容；

5. 分析完成后，服务将提炼出的记忆内容，写入到 Auto Memory 目录下的新主题文件中；随后在`MEMORY.md`核心索引文件中，追加对应的指针条目；

6. 写入完成后，服务会检查新写入的记忆内容，是否与现有记忆文件存在冲突；若存在冲突，会对相关内容进行合并或标记；

7. 服务将提取结果，写入到 Auto Memory 的`logs/`目录下的日志文件中；

8. 服务进入空闲状态，等待下一次被触发。

## 6. 检索匹配机制设计

两层 Memory 机制的检索匹配，采用 “元信息优先、正文按需检索” 的分层过滤策略，先通过元信息筛选，再进行正文检索，减少对存储资源的无效访问。该策略的执行逻辑，由平台的记忆检索服务统一负责。

### 6.1 元信息检索

检索时先读取目标记忆目录下的所有记忆文件的 YAML frontmatter 元信息，不读取具体的文件正文内容；随后，根据元信息的`type`、`scope`、`tags`、`project_id`、`session_id`等字段，与检索请求的过滤条件进行精准匹配；若元信息中包含`tags`字段，会优先使用该字段进行过滤，快速排除不符合条件的记忆文件，缩小后续检索的范围。

### 6.2 索引文件检索

通过元信息检索过滤后，若目标记忆是 Auto Memory，系统会读取其`MEMORY.md`核心索引文件的内容；若为 Session Memory，则读取其`summary.md`摘要文件的内容；随后，对索引或摘要的内容进行关键词匹配，筛选出与当前检索上下文相关的主题文件指针。

### 6.3 正文检索

经过索引文件筛选后，系统会根据筛选出的主题文件指针，批量读取匹配的记忆文件的正文内容；随后，在正文内容中进行精准的关键词或语义匹配，进一步缩小候选记忆范围；这个过程中，系统会仅加载匹配度较高的文件内容，不会读取所有候选文件的正文。

### 6.4 相关性排序

完成正文检索后，系统会对所有匹配到的记忆内容，进行综合相关性打分，将相关度最高的记忆内容，排在结果集的最前面。打分机制遵循以下优先级规则：



* 元信息的匹配度权重，高于正文内容的匹配度权重；

* 记忆文件的最后更新时间越近，其打分权重越高；

* 被检索命中的次数越多，其打分权重越高；

* 与当前会话的上下文标签匹配度越高，其打分权重越高。

### 6.5 结果过滤

系统会根据 Agent 的能力范围、用户的权限级别，以及检索请求的上下文约束，对排序后的结果集进行过滤；将不符合权限要求、或与当前上下文无关的记忆内容，从结果集中移除。

### 6.6 权限校验

在将最终的记忆内容返回给调用方前，系统会进行最后一次权限校验，检查当前 Agent 或用户，是否对该记忆的主题文件有读取权限；若没有读取权限，会将该条结果从最终的返回结果集中移除。

### 6.7 检索流程

完整的记忆检索流程，按以下顺序执行，确保以最少的磁盘 IO 次数，获得精准的检索结果：



1. 平台的记忆检索服务，接收到包含`Session ID`、`Project ID`和检索关键词的查询请求；

2. 服务根据`Session ID`和`Project ID`，确定待检索的目标记忆目录范围，以及作用域过滤条件；

3. 服务先检索 Auto Memory 的核心索引文件或 Session Memory 的摘要文件，定位相关的主题文件指针；

4. 服务读取匹配到的主题文件的元信息，进行第一轮过滤；

5. 服务对元信息过滤后的结果，进行正文内容检索，得到候选结果集；

6. 服务对候选结果集进行相关性打分、排序，并根据检索请求的上下文约束，进行二次过滤；

7. 服务对过滤后的结果集，进行读取权限校验；

8. 服务将最终的结果集，返回给调用方；若结果集不为空，调用方会将记忆内容，注入到 Agent 的上下文窗口中。

## 7. 附录

### 7.1 相关文件清单



| 路径                                                  | 描述                     | 模板来源                           |
| --------------------------------------------------- | ---------------------- | ------------------------------ |
| `agent_memory/sessions/{session_id}/summary.md`     | 会话级完整摘要文件              | 行业标准摘要文件模板                     |
| `agent_memory/sessions/{session_id}/incremental/`   | 会话级增量摘要存储目录            | 行业标准增量存储目录模板                   |
| `agent_memory/projects/{project_id}/MEMORY.md`      | 项目级 Auto Memory 核心索引文件 | Claude Memory System 核心索引文件模板  |
| `agent_memory/projects/{project_id}/*.md`           | 项目级 Auto Memory 主题内容文件 | Claude Memory System 主题文件模板    |
| `agent_memory/projects/{project_id}/team/MEMORY.md` | 团队级共享记忆索引文件            | Claude Memory System 团队级索引文件模板 |
| `agent_memory/projects/{project_id}/team/*.md`      | 团队级共享记忆主题内容文件          | Claude Memory System 主题文件模板    |

### 7.2 元信息（Frontmatter）字段规范



| 字段名           | 类型     | 必选   | 描述            | 验证规则                                                                                           |
| ------------- | ------ | ---- | ------------- | ---------------------------------------------------------------------------------------------- |
| `name`        | string | 是    | 记忆的唯一标识符      | 小写字母、数字、连字符组成，必须与文件名完全一致                                                                       |
| `title`       | string | 是    | 记忆的人类可读名称     | 无特殊字符限制                                                                                        |
| `description` | string | 是    | 记忆的简要描述       | 长度不超过 500 字符                                                                                   |
| `type`        | string | 是    | 记忆的类型         | 必须是`session_summary`/`user_preference`/`project_context`/`decision`/`feedback`/`reference`中的一种 |
| `scope`       | string | 是    | 记忆的作用域        | 必须是`session`/`project`/`team`中的一种                                                              |
| `session_id`  | string | 条件必选 | 关联的会话唯一标识     | 仅当`scope`为`session`时必填                                                                         |
| `project_id`  | string | 是    | 关联的项目唯一标识     | 无                                                                                              |
| `team_id`     | string | 条件必选 | 关联的团队唯一标识     | 仅当`scope`为`team`时必填                                                                            |
| `created_at`  | string | 是    | 记忆的创建时间       | 必须为 ISO8601 的 UTC 标准时间格式                                                                       |
| `updated_at`  | string | 是    | 记忆的最后更新时间     | 必须为 ISO8601 的 UTC 标准时间格式                                                                       |
| `agent`       | string | 否    | 关联的 Agent 名称  | 无                                                                                              |
| `tags`        | array  | 否    | 记忆的分类标签数组     | 由字符串组成的数组，每个元素为一个分类标签                                                                          |
| `sources`     | array  | 否    | 记忆的原始来源文件路径数组 | 由合法文件路径组成的数组                                                                                   |

### 7.3 检索匹配规则说明

完整的检索匹配规则由以下参数共同控制，开发者可以按需调整参数的优先级，适配不同的业务场景：



| 参数名                                | 描述                               | 默认值          | 可调范围                |
| ---------------------------------- | -------------------------------- | ------------ | ------------------- |
| `compaction_enabled`               | 是否启用上下文压缩功能                      | true         | true/false          |
| `compaction_threshold`             | 触发上下文压缩的 Token 阈值                | 模型上下文窗口的 90% | 模型最大上下文窗口的 50%\~90% |
| `compaction_max_summary_length`    | 压缩后的完整摘要最大长度                     | 模型上下文窗口的 10% | 模型最大上下文窗口的 5%\~20%  |
| `session_memory_max_turns`         | Session Memory 中保留的完整对话轮次        | 10           | 5\~50               |
| `auto_memory_index_max_lines`      | Auto Memory 核心索引文件的最大行数          | 200          | 100\~1000           |
| `auto_memory_index_max_bytes`      | Auto Memory 核心索引文件的最大体积          | 25000        | 1024\~102400        |
| `auto_memory_extract_delay_ms`     | 后台提取服务的延迟触发时长                    | 3000         | 0\~10000            |
| `auto_memory_extract_max_turns`    | 后台提取服务单次处理的最大轮次                  | 5            | 1\~10               |
| `auto_memory_max_recent_days`      | 加载最近记忆的最大天数                      | 7            | 1\~30               |
| `auto_memory_max_topic_files`      | 单次检索加载的最大主题文件数量                  | 5            | 1\~20               |
| `memory_cache_ttl_seconds`         | 记忆内容在内存缓存中的留存时长                  | 300          | 60\~3600            |
| `session_memory_retention_minutes` | 会话终止后，Session Memory 文件在磁盘上的保留时长 | 1440         | 60\~10080           |
| `auto_memory_archive_days`         | 未被使用的记忆内容，从项目目录移动到归档目录的时长        | 30           | 7\~180              |
| `auto_memory_max_archive_days`     | 归档后的记忆文件，在磁盘上保留的最大时长             | 90           | 30\~360             |

### 7.4 与 Multi-agent 平台的适配接口细节

两层 Memory 机制，需要与 Multi-agent 平台的以下核心模块适配，才能正常运行：



| 平台模块   | 适配接口                               | 接口功能                             | 实现约束                     |
| ------ | ---------------------------------- | -------------------------------- | ------------------------ |
| 会话管理器  | SessionMemory.read()               | 读取 Session Memory 的摘要内容          | 同步读取，返回完整的摘要字符串          |
| 会话管理器  | SessionMemory.write\_incremental() | 写入 Session Memory 的增量摘要内容        | 异步追加写入，不阻塞主会话响应          |
| 会话管理器  | SessionMemory.write\_full()        | 写入 Session Memory 的完整摘要内容        | 同步覆盖写入，需要阻塞主会话请求         |
| 上下文管理器 | SessionMemory.compress()           | 触发 Session Memory 的上下文压缩流程       | 同步执行，压缩完成后返回新的完整摘要       |
| 上下文管理器 | AutoMemory.load\_index()           | 加载 Auto Memory 的核心索引文件           | 同步读取，返回核心索引的内容字符串        |
| 上下文管理器 | AutoMemory.retrieve\_topic()       | 根据指针检索 Auto Memory 的主题文件内容       | 同步读取，返回主题文件的内容字符串        |
| 上下文管理器 | AutoMemory.inject\_to\_prompt()    | 将检索到的记忆内容，注入到 Agent 的上下文窗口中      | 同步执行，需要保证注入的内容不超过上下文窗口上限 |
| 记忆提取服务 | AutoMemory.write\_topic()          | 将提炼后的记忆内容，写入到 Auto Memory 的主题文件中 | 异步追加写入，需要保证写入的内容不重复      |
| 记忆提取服务 | AutoMemory.update\_index()         | 更新 Auto Memory 的核心索引文件           | 异步追加写入，需要保证索引条目的唯一性      |
| 文件同步服务 | TeamMemory.sync()                  | 将团队记忆的变更内容，同步到中心存储节点             | 异步传输，采用增量同步机制保证传输效率      |
| 文件同步服务 | TeamMemory.watch()                 | 监听本地团队记忆的文件变更事件                  | 采用异步非阻塞监听，延迟 2s 触发同步     |

所有适配接口的参数格式、返回值类型、异常码定义，以及平台各模块之间的交互时序图，均由平台的详细接口设计文档补充定义。

### 7.5 参考的行业级设计规范

本设计参考了以下行业内主流的 Multi-agent 框架记忆系统设计规范：



| 框架名称        | 参考设计来源                                                                                                              | 参考的核心设计点                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Claude Code | [Auto-Memory Design Document](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md) | 基于文件的长期记忆存储、两级索引结构、后台提取服务逻辑  |
| OpenClaw    | [AI Agent 生产级记忆系统目录结构](https://juejin.cn/post/7611383061968601134)                                                  | 目录隔离规范、元信息格式规范、会话级记忆隔离逻辑     |
| AgentScope  | [Agent Scope Java 2.x Harness: 双层记忆机制](https://blog.csdn.net/qq_43437874/article/details/162078295)                 | 上下文压缩策略、两层记忆交互流程             |
| Mem0        | [Multi-Agent Collaboration](https://docs.mem0.ai/cookbooks/frameworks/llamaindex-multiagent)                        | 跨会话记忆检索、会话级与长期记忆的分层隔离        |
| LangGraph   | [Long-term memory](https://langchain-ai.github.io/langgraph/concepts/memory/#long-term-memory)                      | 持久化记忆的存储协议、记忆的生命周期管理         |
| MetaGPT     | [双层记忆机制](https://blog.csdn.net/u014419174/article/details/152412478)                                                | 个体缓存与共享记忆池的隔离、跨 Agent 记忆复用逻辑 |

### 7.6 文档变更记录



| 版本号   | 变更日期       | 变更内容                 | 变更人                |
| ----- | ---------- | -------------------- | ------------------ |
| 1.0.0 | 2026-08-31 | 初始版本，完成完整的两层记忆机制设计文档 | Multi-agent 平台架构团队 |

**参考资料&#x20;**

\[1] 某团二面:多Agent之间怎么实现共享记忆?从文件到治理型架构\_AI科技孙先生[ http://m.toutiao.com/group/7673318880072270355/](http://m.toutiao.com/group/7673318880072270355/)

\[2] 开源多智能体框架深度分析与技术选型指南\_智能体框架选型及多模态ai能力组件技术研究-CSDN博客[ https://blog.csdn.net/u014419174/article/details/152412478](https://blog.csdn.net/u014419174/article/details/152412478)

\[3] AI Agent 总是答不一样?用双 Memory 架构把成功经验沉淀下来 - 亚马逊云开发者 - 博客园[ https://www.cnblogs.com/AmazonwebService/p/19868921](https://www.cnblogs.com/AmazonwebService/p/19868921)

\[4] Designing Multi-Agent Intelligence[ https://developer.microsoft.com/blog/designing-multi-agent-intelligence](https://developer.microsoft.com/blog/designing-multi-agent-intelligence)

\[5] OpenAgent 技术白皮书|深度拆解:真正可落地的开源多智能体框架-CSDN博客[ https://blog.csdn.net/maxDream0531/article/details/161023903](https://blog.csdn.net/maxDream0531/article/details/161023903)

\[6] Multi-Agent Memory Architecture: How do you keep 5+ agents from going insane? #1419[ https://github.com/anthropics/anthropic-sdk-python/discussions/1419](https://github.com/anthropics/anthropic-sdk-python/discussions/1419)

\[7] GitHub - maksim-tsi/mas-memory-layer: A hybrid memory system for Multi-Agent LLM-based Systems[ https://github.com/maksim-tsi/mas-memory-layer](https://github.com/maksim-tsi/mas-memory-layer)

\[8] Hierarchical Memory Sharing in Multi-Agent Systems: A Privacy-Efficiency Trade-off Framework[ https://nanoagentteam.github.io/assets/hierarchical-memory-mas.pdf](https://nanoagentteam.github.io/assets/hierarchical-memory-mas.pdf)

\[9] 【GitHub开源项目实战】Eliza OS 实战解析:AI 原生操作系统的多智能体协作框架与系统模块设计全景\_elizaos-CSDN博客[ https://blog.csdn.net/sinat\_28461591/article/details/147887349](https://blog.csdn.net/sinat_28461591/article/details/147887349)

\[10] 从桌面应用到 Agent 操作系统:一个生产级多智能体系统的记忆体系与工具生态-CSDN博客[ https://blog.csdn.net/weixin\_43198159/article/details/161338205](https://blog.csdn.net/weixin_43198159/article/details/161338205)

\[11] A2A Memory System: Advanced Agent-to-Agent Communication System[ https://github.com/Sardor-M/a2a-memory-system](https://github.com/Sardor-M/a2a-memory-system)

\[12] Strands Agent Chatbot with Amazon Bedrock AgentCore[ https://github.com/aws-samples/sample-strands-agent-with-agentcore](https://github.com/aws-samples/sample-strands-agent-with-agentcore)

\[13] 别再只用RAG做知识库!四层分层记忆解决多Agent团队协作孤岛难题-腾讯云开发者社区-腾讯云[ https://developer.cloud.tencent.com.cn/article/2722168?policyId=1004](https://developer.cloud.tencent.com.cn/article/2722168?policyId=1004)

\[14] 如何高效实现智能体多轮对话记忆:OpenAI-Agents Session系统实战指南-CSDN博客[ https://blog.csdn.net/gitblog\_01107/article/details/151246850](https://blog.csdn.net/gitblog_01107/article/details/151246850)

\[15] Google ADK[ https://docs.mem0.ai/integrations/google-ai-adk](https://docs.mem0.ai/integrations/google-ai-adk)

\[16] Multi-Agent Collaboration[ https://docs.mem0.ai/cookbooks/frameworks/llamaindex-multiagent](https://docs.mem0.ai/cookbooks/frameworks/llamaindex-multiagent)

\[17] AI Agent 生产级记忆系统目录结构基于 OpenClaw 多 Agent 团队的真实生产环境，历时 17 天打磨。 - 掘金[ https://juejin.cn/post/7611383061968601134](https://juejin.cn/post/7611383061968601134)

\[18] AgentOS[ https://github.com/dhruvbreathe/AgentOS](https://github.com/dhruvbreathe/AgentOS)

\[19] 首个 Java Harness Framework 来了|AgentScope 把 OpenClaw 带到企业分布式场景\_腾讯新闻[ https://news.qq.com/rain/a/20260515A02FZG00](https://news.qq.com/rain/a/20260515A02FZG00)

\[20] OrionAgent[ https://github.com/Sam-Dev-AI/OrionAgent](https://github.com/Sam-Dev-AI/OrionAgent)

\[21] 【AgentScope】3. 工作空间(Workspace)详解\_agentscope builder-CSDN博客[ https://blog.csdn.net/qq\_38723677/article/details/161666169](https://blog.csdn.net/qq_38723677/article/details/161666169)

\[22] 适用于生产工作流的 4 层 AI Agent 记忆架构[ https://youmind.com/zh-CN/landing/x-viral-articles/ai-agent-memory-architecture-guide](https://youmind.com/zh-CN/landing/x-viral-articles/ai-agent-memory-architecture-guide)

\[23] Agent Memory Framework[ https://github.com/polyarslan/agent-memory-framework](https://github.com/polyarslan/agent-memory-framework)

\[24] OpenClaw 会话管理:4 种隔离模式 + 1 套修剪机制，让 AI Agent 从"记忆混乱"到"多用户安全"-腾讯云开发者社区-腾讯云[ https://cloud.tencent.com/developer/article/2649103](https://cloud.tencent.com/developer/article/2649103)

\[25] AI Agent 生产级记忆系统目录结构基于 OpenClaw 多 Agent 团队的真实生产环境，历时 17 天打磨。 - 掘金[ https://juejin.cn/post/7611383061968601134](https://juejin.cn/post/7611383061968601134)

\[26] Agents Library — Full Reference Guide[ https://github.com/alexsmedile/apm/blob/main/docs/DATABASE\_LIBRARY.md](https://github.com/alexsmedile/apm/blob/main/docs/DATABASE_LIBRARY.md)

\[27] agent-conventions[ https://agents.w4w.dev/skills/catalog/custom/agent-conventions/](https://agents.w4w.dev/skills/catalog/custom/agent-conventions/)

\[28] 三月 | 2026 | 潘锦的空间[ https://www.phppan.com/2026/03/](https://www.phppan.com/2026/03/)

\[29] LLM-Wiki企业级AI知识库实战教程-腾讯云开发者社区-腾讯云[ https://developer.cloud.tencent.com/article/2699290](https://developer.cloud.tencent.com/article/2699290)

\[30] Self-Maintaining Agent Knowledge Store[ https://gist.github.com/mpalpha/de4bb77f8a62d909c603ca0ef7028b4b](https://gist.github.com/mpalpha/de4bb77f8a62d909c603ca0ef7028b4b)

\[31] Distributable AGENTS.md template (OKF-inspired, minimal kernel). Fill the %% placeholders, delete the guidance comments, save as AGENTS.md in your vault root.[ https://gist.github.com/dikiprawisuda/d43a887643f2cf2658712379ffced4bc](https://gist.github.com/dikiprawisuda/d43a887643f2cf2658712379ffced4bc)

\[32] Claude Code 记忆系统深度分析:基于源码泄露的三层架构解密 | SmallYoung[ https://www.smallyoung.cn/docs/018-Claude\_Code%E8%AE%B0%E5%BF%86%E7%B3%BB%E7%BB%9F%E6%B7%B1%E5%BA%A6%E5%88%86%E6%9E%90](https://www.smallyoung.cn/docs/018-Claude_Code%E8%AE%B0%E5%BF%86%E7%B3%BB%E7%BB%9F%E6%B7%B1%E5%BA%A6%E5%88%86%E6%9E%90)

\[33] 企业级 MultiAgent 的记忆系统:短期上下文与四层记忆架构实现-51CTO.COM[ https://www.51cto.com/article/854121.html](https://www.51cto.com/article/854121.html)

\[34] 只有 Prompt 是不够的:AgentScope Java 1.1.0 全新 Harness 架构设计详解 - 阿里云云原生 - 博客园[ https://www.cnblogs.com/alisystemsoftware/p/20084018](https://www.cnblogs.com/alisystemsoftware/p/20084018)

\[35] Agent Memory[ https://docs.swarms.world/agents/agent-memory](https://docs.swarms.world/agents/agent-memory)

\[36] 多智能体协作编排实战：任务拆解+工具调用+记忆模块设计指南[ https://agent.csdn.net/6a64b87110ee7a33f2926098.html](https://agent.csdn.net/6a64b87110ee7a33f2926098.html)

\[37] 会话记忆引擎:为AI Agent赋予持久化智能记忆-CSDN博客[ https://blog.csdn.net/gitblog\_00482/article/details/158276175](https://blog.csdn.net/gitblog_00482/article/details/158276175)

\[38] MCP Platform[ https://github.com/MichaelYagi/mcp-platform](https://github.com/MichaelYagi/mcp-platform)

\[39] State & Memory Management[ https://nerdleveltech.com/courses/ai-system-design-interviews/learn/multi-agent-system-design/state-memory-management](https://nerdleveltech.com/courses/ai-system-design-interviews/learn/multi-agent-system-design/state-memory-management)

\[40] 多智能体架构下的多轮对话上下文管理:从设计到实现-腾讯云开发者社区-腾讯云[ https://cloud.tencent.com/developer/article/2699038](https://cloud.tencent.com/developer/article/2699038)

\[41] 多 Agent 记忆系统重构:从“什么都记“到“精准召回“\_重构\_lyyukai-AtomGit开源社区[ https://gitcode.csdn.net/69cfd3060a2f6a37c59cce47.html](https://gitcode.csdn.net/69cfd3060a2f6a37c59cce47.html)

\[42] obsidian-note-expert[ https://lobehub.com/skills/agoodboywlb-pensieve-obsidian-skill-obsidian-note](https://lobehub.com/skills/agoodboywlb-pensieve-obsidian-skill-obsidian-note)

\[43] AI Agent 生产级记忆系统目录结构基于 OpenClaw 多 Agent 团队的真实生产环境，历时 17 天打磨。 - 掘金[ https://juejin.cn/post/7611383061968601134](https://juejin.cn/post/7611383061968601134)

\[44] Auto-Memory — Design Document[ https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md](https://github.com/changkun/claude-design-docs/blob/main/infra/auto-memory-design.md)

\[45] OpenClaw三层混合记忆系统:为AI智能体构建私有文件、共享文档与知识图谱-CSDN博客[ https://blog.csdn.net/weixin\_28725959/article/details/160838247](https://blog.csdn.net/weixin_28725959/article/details/160838247)

\[46] Agent Memory Framework[ https://github.com/polyarslan/agent-memory-framework](https://github.com/polyarslan/agent-memory-framework)

\[47] 一文讲清 Agent 的记忆系统:设计思路与工程实现本文系统梳理 Agent 记忆体系的整体设计方案，围绕“记什么、怎么 - 掘金[ https://juejin.cn/post/7632183431921975346](https://juejin.cn/post/7632183431921975346)

\[48] Claude Code 源码深度解析:运行机制与 Memory 模块详解[ https://qingkeai.online/archives/ClaudeCode-Memory](https://qingkeai.online/archives/ClaudeCode-Memory)

\[49] 企业级 MultiAgent 的记忆系统:短期上下文与四层记忆架构实现\_得物技术[ http://m.toutiao.com/group/7678539476636811810/](http://m.toutiao.com/group/7678539476636811810/)

\[50] Agent Scope Java 2.x 系列【22】Harness:上下文压缩\_agentscope 2 实现历史消息-CSDN博客[ https://blog.csdn.net/qq\_43437874/article/details/162102550](https://blog.csdn.net/qq_43437874/article/details/162102550)

\[51] Agent Scope Java 2.x 系列【23】Harness:双层记忆机制\_java分层记忆框架-CSDN博客[ https://blog.csdn.net/qq\_43437874/article/details/162078295](https://blog.csdn.net/qq_43437874/article/details/162078295)

\[52] OpenClaw Sessions 系统:AI 对话的记忆管理大师引言:为什么需要 Sessions 系统? 想象你正在 - 掘金[ https://juejin.cn/post/7615250753898545215](https://juejin.cn/post/7615250753898545215)

\[53] 别再盲目安装了:深度拆解 Hermes Agent 的“脑回路”\_月更\_HELLO程序员\_InfoQ写作社区[ https://xie.infoq.cn/article/a5e30b4759cec573f3a3ca31f](https://xie.infoq.cn/article/a5e30b4759cec573f3a3ca31f)

\[54] Context Compression[ https://docs.swarms.world/examples/agents/context-compression](https://docs.swarms.world/examples/agents/context-compression)

\[55] Production AI Agent Systems Architecture[ https://github.com/beena-yatin-kanyal/agentic-documentation/blob/master/part-2-memory-and-context-management.md](https://github.com/beena-yatin-kanyal/agentic-documentation/blob/master/part-2-memory-and-context-management.md)

\[56] AI Agent 生产级记忆系统目录结构基于 OpenClaw 多 Agent 团队的真实生产环境，历时 17 天打磨。 - 掘金[ https://juejin.cn/post/7611383061968601134](https://juejin.cn/post/7611383061968601134)

\[57] Claude Code 中的 agents 目录详解:自定义子代理完全指南\_claude code agents-CSDN博客[ https://blog.csdn.net/u013318019/article/details/159019197](https://blog.csdn.net/u013318019/article/details/159019197)

\[58] agent-conventions[ https://agents.w4w.dev/skills/catalog/custom/agent-conventions/](https://agents.w4w.dev/skills/catalog/custom/agent-conventions/)

\[59] GitHub文章[ http://raw.githubusercontent.com/ERerGB/subagent-harness/HEAD/docs/YAML\_SUBSET.md](http://raw.githubusercontent.com/ERerGB/subagent-harness/HEAD/docs/YAML_SUBSET.md)

\[60] Custom Agents[ https://claude-code-explain.helmcode.com/custom-agents/](https://claude-code-explain.helmcode.com/custom-agents/)

\[61] Claude Code Subagent 创建指南Claude Code Subagent 创建指南 1. 什么是 Su - 掘金[ https://juejin.cn/post/7613970761350905856](https://juejin.cn/post/7613970761350905856)

\[62] LLM-Wiki企业级AI知识库实战教程-腾讯云开发者社区-腾讯云[ https://developer.cloud.tencent.com/article/2699290](https://developer.cloud.tencent.com/article/2699290)

\[63] ✨ feat: プロンプト作成基準が .claude/rules/prompt-writing.md として確立され、claude-code-guide 必須参照で Claude Code 仕様逸脱が検知できるようになる#597[ https://github.com/hirokimry/vibecorp/pull/597/files/1492994acf812b413ae3f138820bf3fd6f2c54d8](https://github.com/hirokimry/vibecorp/pull/597/files/1492994acf812b413ae3f138820bf3fd6f2c54d8)

> （注：文档部分内容可能由 AI 生成）