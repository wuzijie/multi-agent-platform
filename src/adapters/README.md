# CLI 抽象层接口定义

## 统一输入格式 (UnifiedInput)

传递给任意模型适配器的标准输入结构：

```json
{
  "task_id": "uuid",
  "role": "executor | reviewer | guardian",
  "context": "任务上下文与背景",
  "instruction": "具体执行指令",
  "input_files": ["file_paths"],
  "max_tokens": 4096
}
```

## 统一输出格式 (UnifiedOutput)

任意模型适配器执行后返回的标准输出结构：

```json
{
  "task_id": "uuid",
  "status": "success | failed | timeout",
  "content": "产出文本内容",
  "output_files": ["file_paths"],
  "error": { "code": "xxx", "message": "xxx" },
  "tokens_used": 1234,
  "duration_ms": 5000
}
```

## 适配器接口 (AdapterInterface)

每个模型 CLI 对应的适配器必须实现以下方法：

- `execute(input: UnifiedInput): Promise<UnifiedOutput>`
  - 将 UnifiedInput 翻译为对应 CLI 的原生参数格式
  - 调用 CLI 执行
  - 将原生输出标准化为 UnifiedOutput

- `healthCheck(): Promise<{ online: boolean, latency_ms: number }>`
  - 检测模型 CLI 是否可用

- `getName(): string`
  - 返回适配器名称

## 一期实现

- 克劳德 (Claude Code CLI) 适配器：仅此一个
- 其余适配器（吉米 / 迪普斯克 / 钱文）二期开发
