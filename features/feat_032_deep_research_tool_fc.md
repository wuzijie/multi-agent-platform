# feat_032: deep-research 改为模型可调用工具 + 通用工具框架 + CLI-only

## 概述

deep-research 从“关键词触发 + JS 固定流程”改为**大模型自主判断、通过 function calling 调用**的工具；并建立通用工具框架（ToolRegistry），所有工具统一经此调用。**工具定义（名字/描述/参数 schema）外置在 skill 的 md 文件 frontmatter（`tool:` 段）**，修改工具定义只改 md 不用动代码。同时按“所有模型不使用 API”要求，DeepSeek/Qwen 适配器删除直连 API 路径，纯走 CLI。

## 核心文件

| 文件 | 说明 |
|------|------|
| `skills/*.md` | **skill + 工具唯一定义源**：frontmatter `tool:`（name/description/parameters）+ `execution:`（执行方式）+ 正文 ```prompt 模板 / ```skill-execute 内联脚本 |
| `src/tools/registry.js` | **通用工具注册表**：扫描 skills/*.md 的 tool 段自动注册；执行方式从 md 的 execution 读取（module=require JS 模块 / inline=内联脚本），handler 懒加载防循环依赖；`getToolPrompt()` / `parseToolCallsFromText()` 伪 FC |
| `src/skills/loader.js` | 解析 md：frontmatter + prompt 模板块 + ```skill-execute 内联脚本块 |
| `src/agent/runtime.js` | FC 循环：模型输出 `[TOOL_CALL]` 块 -> 解析 -> 执行工具 -> 结果回灌 -> 再调模型；工具说明直接拼入 context；`disableTools` 防内部递归 |
| `src/skills/deep-research.js` | deep_research 的执行模块：单例导出 `handler(args, ctx)`（跑 5 步流程拿终稿）；内部调用 `disableTools:true`；提供 `stopAll()` |
| `src/orchestrator/orchestrator.js` | 移除关键词触发分支；executor.run / _planTask 设 `disableTools`；`stopAllTasks()` |
| `src/adapters/deepseek.js` / `qwen.js` | 删除 openai-sse 直连 API 路径，纯走 CLI |

## 新增 skill 的标准流程（通用型，无需改 JS）

写一个 `skills/xxx.md`：

```markdown
---
id: my_skill
name: 我的技能
description: 一句话描述
enabled: true
tool:
  name: my_skill
  description: 暴露给模型的工具描述（何时调用）
  parameters:
    type: object
    properties: { ... }   # JSON Schema
    required: [...]
execution:
  type: module            # 方式一：require 一个 JS 模块（导出 async handler(args, ctx)）
  module: src/skills/my-skill.js   # 相对项目根，默认 src/skills/<id>.js
  # --- 或 ---
  # type: inline          # 方式二：用正文里的 ```skill-execute 内联脚本
---
```

方式一（module）：写 `src/skills/my-skill.js`，`module.exports = { handler: async (args, ctx) => { ... 返回字符串结果 ... } }`。
方式二（inline）：md 正文放

````markdown
```skill-execute
module.exports = async function(args, ctx) {
  // 可 require 项目模块（相对项目根解析）
  return '结果: ' + args.xxx;
};
```
````

两种方式都不需要改 registry / runtime。模型侧自动通过 `getToolPrompt()` 看到新工具。

## function calling 机制（伪 FC，CLI 通用）

四个适配器都走 CLI，CLI 不原生支持自定义 function calling，故采用**约定式伪 FC**（统一、不依赖各 CLI 能力差异）：

1. `ToolRegistry.getToolPrompt()` 生成工具说明（含调用标记格式），由 `agentRuntime` 直接拼入 context 前部
2. 模型判断需要调研/方案/深度讨论时，在回复中输出：
   `[TOOL_CALL]{"name":"deep_research","arguments":{"query":"..."}}[/TOOL_CALL]`
3. `agentRuntime` 调适配器拿到回复后，`parseToolCallsFromText()` 解析标记
4. 解析到 -> `toolRegistry.execute(name, args, ctx)` 执行工具（deep_research 跑 5 步流程拿终稿）
5. 工具结果作为“已调用工具”回灌 context，重新调模型生成最终回复（最多 5 轮）

### 防递归
- **用户直接对话**（orchestrator `_executeAgentWithMentions` 一线的模型调用）：启用工具循环，模型可自主调 deep_research
- **被编排的内部调用一律禁用工具**：调度器协作子任务（orchestrator executor.run，设 `subTask.disableTools=true`）、任务规划 `_planTask`（`disableTools:true`）、skill 内部 5 步调用（`disableTools:true`）。否则会出现"子任务里嵌套启动 deep_research、外层调度器 300s 超时监控与内层 skill 互相打架"（2026-08-27 日志实锤）

### 循环依赖
runtime -> toolRegistry -> deep-research 工具 -> deep-research skill -> runtime 形成加载期环。`src/tools/deep-research.js` 用懒 `require('../skills/deep-research')` 在 handler 内引入，打破环。

## deep_research 工具

- name: `deep_research`
- description: 多模型并行多角度调研 + 汇总成文 + 跨模型审核 + 迭代终稿；用户需求为调研报告/行业·竞品分析/方案制定/深度讨论/多角度论证/可行性分析时调用
- parameters: `{query: string}`
- handler: 调 `deepResearch.run({userQuery, mainAgent})`，返回终稿文本

## CLI-only（移除 API 直连）

- `deepseek.js`：删除 streamChatCompletion 直连块，仅 `_runCli` 走 qwen CLI（cliCommand='qwen'，对接 DeepSeek API）
- `qwen.js`：同上，仅走 qwen CLI
- `openai-sse.js`：保留文件但不再被引用

## 冒烟测试

- `outputs/test-fc-loop.js`：stub 适配器输出 [TOOL_CALL] -> runtime 执行 deep_research 工具 -> 终稿回灌 -> 第二轮模型给最终回复；`disableTools` 下不解析（防递归）。全绿
- `outputs/test-deep-research.js`：原有 5 步闭环 + 审核隔离 + md 模板渲染，循环依赖修复后重跑全绿

## 状态

已完成，2026-08-25（未提交，按用户偏好留工作区）
