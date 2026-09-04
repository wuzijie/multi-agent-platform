---
id: fetch_full
name: 按需读取全量内容
description: 在多模型协作讨论中，按键值拉取某条消息的完整正文
enabled: true

tool:
  name: fetch_full
  description: 按键值拉取某条讨论消息的完整正文。在多方辩论/头脑风暴/一对一辩论模式下，历史摘要中每条消息带有一个 full_key 字段，当你需要查看某条消息的完整细节时调用本工具。
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
  module: src/skills/fetch-full.js
---
