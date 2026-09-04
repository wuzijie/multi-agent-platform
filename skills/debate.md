---
id: debate
name: 多方辩论模式
description: 多Agent并行观点发散 + 交叉匿名点评 + 自我辩解修正 + 二次深度博弈 + 终修正共识分歧拆解，6轮可迭代
enabled: true

tool:
  name: debate
  description: |
    启动多方辩论模式（严谨论证型）。多个Agent并行输出初始观点、交叉匿名点评、自我辩解修正、二次深度博弈、终修正共识分歧拆解，共6轮可迭代。
    适用场景：方案论证、问题研判、观点辨析、可行性分析。
    触发条件：用户明确说"多模型讨论/多方辩论/多Agent论证"等，或模型判断需要多角度博弈时调用。
    如果用户未明确指定协作模式但表达了讨论意图，可以先询问用户选择哪种模式。
  parameters:
    type: object
    properties:
      topic:
        type: string
        description: 讨论主题
      participants:
        type: string
        description: 参与者模型名单（逗号分隔，如"迪普斯克,钱文"），留空则自动选取3-5个已启用模型
    required:
      - topic

execution:
  type: module
  module: src/skills/debate.js
---
