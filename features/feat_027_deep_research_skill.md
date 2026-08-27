# feat_027: 深度调研 Skill（DeepResearch 标准化技能）

## 概述

按《Multi-Agent 深度调研 Skill（标准化技能定义）》实现平台第一个标准化 Skill，供所有 Agent/模型使用：多模型并行多角度调研 + 主模型汇总成文 + 跨模型交叉审核 + 迭代修正终稿，产出高质量、多维度、低偏见的调研报告。

纯事件+回调驱动（每步完成发布事件触发下一步，无轮询无阻塞），复用消息总线 / 文件黑板 / agentRuntime 流式执行器 / 右侧任务面板 / 前端流式气泡等全部现有基础设施。

## 核心文件

| 文件 | 说明 |
|------|------|
| `skills/deep-research.md` | **技能唯一定义源**：frontmatter（id/触发词/参数）+ 提示词模板（` ```prompt ` 代码块）+ 标准化定义正文；修改触发词/提示词/参数只改此文件 |
| `src/skills/loader.js` | Skill 定义加载器：解析 frontmatter（js-yaml）与 prompt 模板块，`loadAllSkills()` 扫描 skills/*.md |
| `src/skills/deep-research.js` | 执行器：5 步事件闭环；启动时从 md 加载触发词/参数/模板，md 缺失时用内置兜底 |
| `src/engine/events.js` | 新增 `SKILL_EVENTS`（6 个 Skill 专属事件） |
| `src/orchestrator/orchestrator.js` | 触发准入 + `_executeDeepResearch` 执行入口 + 类型标签 |
| `src/api/server.js` | execute/chat 接口透传 `skill` 参数 |
| `frontend/index.html` | 面板类型标签新增「调研」「终稿」 |

## 触发条件（§二 精准准入）

满足任一自动触发（`deepResearch.detect()`，关键词全部来自 `skills/deep-research.md` 的 `triggers`）：

1. 成文类：调研 / 研究报告 / 研究一下 / 行业分析 / 市场分析 / 竞品分析 / 竞争分析 / 深度总结 / 深度分析 / 深入分析 / 全面分析 / 对比分析 / 可行性分析 / 复盘
2. 方案设计类：方案 / 制定（"制定一个多agent协同工作的方案"这类需求）
3. 多视角/决策类：多角度 / 多维度 / 多视角 / 利弊 / 优劣 / 正反 / 该不该 / 要不要 / 值不值得
3. 显式指定：API 传 `skill: "deep_research"`（强制触发）

禁止触发：短消息（< `trigger_min_length`=8 字符视为简单问答）。

> 2026-08-25 修订：初版触发词过窄（"帮我调研一下…"不触发），已外置到 md 并大幅扩充（23 个关键词）；
> Skill 定义同步改为 .md 外置形式（用户要求），代码仅做执行器。

## Agent 调度（§三 无能力画像模式）

不依赖能力画像，仅按「角色分工 + 参与状态」调度：

- **主模型**（任务当前绑定 Agent，默认克劳德）：维度拆解、初稿汇总、终稿迭代，全程收口
- **调研模型**：在线非主模型随机分配（至少 2 个不同模型），强制视角差异化；不足时主模型补位兜底，再不足排队 3s 重试一次
- **审核模型（强隔离规则）**：
  1. 优先本轮未参与任何环节的在线空闲模型
  2. 全员参与时禁止主模型自审，从调研模型中轮换选取
  3. 审核失败按隔离规则换人重试一次；仅主模型在线时跳过审核直接定稿（告警落日志）

## 5 步事件闭环（§四）

```
SKILL_DEEP_RESEARCH_START_EVENT      -> Step1 主模型维度拆解（LLM 输出 JSON，失败兜底"正向+反向"双维度，2-5 个维度）
RESEARCH_DIMENSION_READY_EVENT       -> Step2 多模型并行调研（每维度独立调用，失败换模型重试一次；各维度独立黑板快照互不覆盖）
MULTI_RESEARCH_ALL_FINISH_EVENT      -> Step3 主模型汇总成文（去重/互补/纠偏/整合冲突，输出完整初稿）
RESEARCH_DRAFT_FINISH_EVENT          -> Step4 跨模型独立审核（对照调研素材，输出 7 项审核清单）
REVIEW_RESULT_FINISH_EVENT           -> Step5 主模型逐条修订 -> 终稿（终稿失败兜底以初稿交付）
SKILL_DEEP_RESEARCH_COMPLETE_EVENT   -> 任务完结，resolve 调用方
```

## 黑板存储（§七 Skill 专属 Key）

- `blackboard:skill:deep_research:{trace_id}:dimensions` 维度清单
- `blackboard:skill:deep_research:{trace_id}:sub_research` 各模型独立调研结果（Hash，维度名为 field）
- `blackboard:skill:deep_research:{trace_id}:draft` / `:review` / `:final` 初稿 / 审核报告 / 终稿

同时以 `blackboard:task:{trace_id}:main|sub:*` 命名空间记录阶段状态（拆解/各维度调研/汇总/审核/终稿共 N+4 个子任务），使 `GET /tasks/:taskId/collab/state` 与右侧任务面板零改动复用。

## 前端展示

- Step1 完成后一次性推送 `collab:planned`（完整任务列表，含主模型名）
- 各阶段状态经 `collab:subtask:update` 实时更新（新类型标签：调研 / 终稿）
- 各模型调研结果、初稿、审核意见经 `collab:subtask:done` 写入对话流
- 模型调用全程 `agent:stream:*` 流式气泡展示
- 终稿以「深度调研报告（终稿）」写入对话

## 超时与兜底

- 单次模型调用外层超时 400s（适配器内部 240s 超时之外的防悬挂兜底）
- 全部维度调研失败 -> 任务失败；部分成功 -> 继续汇总（告警落日志）
- 维度拆解解析失败 -> 兜底"正向优势 + 反向风险"双维度
- 协作日志：`logs/collab/` 记录 skill_dr_* 全链路事件（start/dimensions_ready/dispatch/research_fail/partial/draft/review_skipped/fail/complete 等）

## 冒烟测试

stub agentRuntime 验证（2026-08-25 通过）：触发检测正反例、5 步闭环 SUCCESS、3 维度 3 模型并行调研（主模型不补位）、审核隔离（全员参与时轮换调研模型、主模型不自审）、黑板 5 专属 Key + 7 面板子任务全部 SUCCESS。

## 状态

已完成，2026-08-25
