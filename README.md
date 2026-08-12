# 多智能体协作平台

**版本**：V1.0（第一期 MVP）

## 概述

一个本地化运行的多智能体协作工具，基于本地配置文件驱动，通过 Web 界面交互，无需外部数据库或消息中间件。

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9
- Git（用于 Worktree 功能）
- Claude Code CLI（用于 Agent 执行）

### 安装

```bash
cd multi-agent-platform
npm install
```

### 启动

```bash
npm start
```

启动后访问 http://localhost:3000 使用 Web 交互界面。

### 配置

编辑 `config/` 目录下的配置文件：

- `agents.yaml`：Agent 角色配置（一期仅克劳德可用）
- `git.yaml`：Git 仓库配置（修改默认仓库地址）
- `users.yaml`：简易用户配置（权限控制）
- `task_defaults.yaml`：任务默认参数
- `api_keys.yaml`：API 密钥配置（Claude Code CLI 认证，首次使用必填）

### Claude Code CLI 认证与模型供应商路由

平台通过 Claude Code CLI 调用大模型，支持以下认证方式（优先级从高到低）：

#### 方式一：cc-switch 可视化工具（推荐）

[cc-switch](https://github.com/farion1231/cc-switch) 是一个开源 GUI 工具，免手动改 JSON 配置文件，可视化切换 DeepSeek / OfoxAI / Anthropic 官方等供应商。

**安装**（macOS）：
```bash
brew install --cask cc-switch
```

Windows/Linux 用户从 [GitHub Releases](https://github.com/farion1231/cc-switch/releases) 下载安装包。

**接入 DeepSeek**：
1. 打开 cc-switch GUI，点右上角「+」添加供应商
2. 填入配置：

| 配置项 | 值 |
|--------|-----|
| 供应商名称 | `deepseek-anthropic`（自定义） |
| API Key | 你的 DeepSeek API Key |
| 请求地址 | `https://api.deepseek.com/anthropic` |
| API 格式 | `Anthropic Messages (原生)` |
| 模型配置 | `deepseek-chat`（推荐） |

3. 点「+ 添加」保存，回到列表点「使用」按钮
4. 看到「切换成功」提示即完成

cc-switch 自动修改 `~/.claude/settings.json`，**无需修改平台任何配置文件**。ClaudeAdapter 已将 HOME 指向宿主机真实目录，cc-switch 配置自动生效。

#### 方式二：配置文件直连（无需 GUI）

编辑 `config/api_keys.yaml`：

```yaml
api_keys:
  anthropic_base_url: "https://api.deepseek.com/anthropic"
  deepseek_api_key: "sk-你的DeepSeek-Key"
  model_override: "deepseek-chat"    # 可选
```

#### 方式三：Anthropic 原生 API

```yaml
api_keys:
  anthropic_api_key: "sk-ant-你的Anthropic-Key"
```

#### 方式四：环境变量

```bash
export ANTHROPIC_API_KEY=sk-xxx
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic  # 使用第三方供应商时
```

#### 方式五：Claude Code 原生登录

在终端运行 `claude /login` 完成交互式登录。无需配置 `api_keys.yaml`。

## 项目结构

```
multi-agent-platform/
├── config/              # 配置文件（agents, git, users, task_defaults）
├── src/                 # 后端源代码
│   ├── index.js         # 主入口
│   ├── adapters/        # CLI 抽象层与模型适配器
│   ├── agent/           # Agent 运行时
│   ├── api/             # REST API + WebSocket 服务
│   ├── eventbus/        # File Event Bus
│   ├── features/        # 特性清单系统
│   ├── orchestrator/    # 任务编排器
│   ├── utils/           # 工具模块（配置加载等）
│   └── worktree/        # Git Worktree 管理
├── frontend/            # Web 前端（React SPA）
├── features/            # 特性清单文件
├── tasks/               # 任务数据（运行期生成）
├── logs/                # 日志文件（运行期生成）
└── workspace/           # Git worktree 工作区（运行期生成）
```

## API 文档

所有 API 以 `/api` 为前缀。

### 任务

- `POST /api/tasks` - 创建任务
- `GET /api/tasks` - 获取任务列表（支持筛选排序）
- `GET /api/tasks/:id` - 获取任务详情
- `GET /api/tasks/:id/conversation` - 获取对话记录
- `POST /api/tasks/:id/execute` - 执行任务
- `POST /api/tasks/:id/chat` - 继续对话
- `POST /api/tasks/:id/terminate` - 终止任务
- `POST /api/tasks/batch/export` - 批量导出
- `POST /api/tasks/batch/delete` - 批量删除

### Agent

- `GET /api/agents` - 获取所有 Agent 状态
- `GET /api/agents/:name` - 获取单个 Agent 状态

### 特性清单

- `GET /api/features` - 获取特性列表
- `GET /api/features/stats` - 获取特性统计
- `POST /api/features` - 创建特性
- `PUT /api/features/:id` - 更新特性

### 其他

- `GET /api/health` - 健康检查
- `GET /api/events` - 事件查询
- `POST /api/analytics/log` - 前端埋点日志
- `GET /api/worktrees` - Worktree 列表
- `GET /api/config/users` - 用户配置

### WebSocket

连接 `ws://localhost:3000/ws` 接收实时事件推送。

## CLI 抽象层扩展指南

如需接入新模型，实现如下接口：

```javascript
class NewModelAdapter {
  getName() { return 'NewModelAdapter'; }
  async execute(input: UnifiedInput): Promise<UnifiedOutput> { /* ... */ }
  async healthCheck(): Promise<{ online: boolean, latency_ms: number }> { /* ... */ }
}
```

UnifiedInput / UnifiedOutput 格式参见 `src/adapters/README.md`。

## 许可证

内部项目
