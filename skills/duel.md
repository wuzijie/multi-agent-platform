---
id: duel
name: 一对一辩论模式
description: 两个Agent交替对抗辩论，2-5轮可变，轻量化辨析
enabled: true

tool:
  name: duel
  description: |
    启动一对一辩论模式（轻量化辨析型）。两个Agent交替输出观点、点评、辩解、修正，2-5轮可变。
    适用场景：简单问题辨析、正反观点博弈、快速对错论证。
    触发条件：用户明确说"一对一讨论/一对一辩论/两个模型对一下"等，或模型判断需要轻量化正反对抗时调用。
    如果用户未明确指定协作模式但表达了讨论意图，可以先询问用户选择哪种模式。
  parameters:
    type: object
    properties:
      topic:
        type: string
        description: 讨论主题
      agent_a:
        type: string
        description: Agent A名称（第一个发言者），留空则自动选取
      agent_b:
        type: string
        description: Agent B名称（第二个发言者），留空则自动选取
    required:
      - topic

execution:
  type: module
  module: src/skills/duel.js
---
