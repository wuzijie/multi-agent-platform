# CLI 抽象层接口定义

## 统一输入格式 (UnifiedInput)

传递给任意模型适配器的标准输入结构：

```json
{
  "task_id": "uuid",
  "external_task_id": "对话级 uuid",
  "role": "executor | reviewer | guardian",
  "context": "稳定上下文（delta 模式下为空）",
  "instruction": "本轮内容",
  "input_files": ["file_paths"],
  "max_tokens": 4096,
  "session": {
    "id": "uuid | null",
    "is_first": true,
    "enabled": true
  }
}
```

`session.enabled=false` 或 `id` 为空时不下发 resume 参数；`is_first=true` 使用
`first_call_args`（如 `--session-id`），否则使用 `resume_args`（如 `--resume`）。
参数模板来自 `config/cli-profiles.yaml`，适配器不得硬编码。

## 统一输出格式 (UnifiedOutput)

```json
{
  "task_id": "uuid",
  "status": "success | failed | timeout | cancelled",
  "content": "产出文本内容",
  "error": { "code": "CANCELLED | TIMEOUT | SESSION_NOT_FOUND | AUTH_REQUIRED | ..." },
  "session_id": "本次捕获到的会话 id",
  "tokens_used": 1234,
  "duration_ms": 5000
}
```

`error.code=SESSION_NOT_FOUND` 是 resume 失效的唯一判据，运行时会清空 session
并用全量模式重试一次。

## 规范事件（contract/events.js）

适配器把各 CLI 原生输出翻译成统一事件，运行时只消费这些事件：

`session.started` / `message.delta` / `message.completed` / `tool.call` /
`tool.result` / `usage` / `log` / `error` / `done`

新增模型 = 新增 `cli-profiles.yaml` 条目 + 一个翻译器，编排层零改动。

## 适配器接口 (AdapterInterface)

- `execute(input, onChunk): Promise<UnifiedOutput>`
- `healthCheck(): Promise<{ online, latency_ms }>`
- `getName(): string`

## 准入

`npm run probe:cli` 探测各 CLI 的 resume 能力并写入 `config/cli-profiles.yaml`。
`require_resume: true` 时，未通过准入的 CLI 在启动阶段被排除，不做降级适配。
