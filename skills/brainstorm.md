---
id: brainstorm
name: 头脑风暴模式
description: 多Agent定向差异化发散 + 分层收敛 + 终极二次收敛，3轮固定
enabled: true

tool:
  name: brainstorm
  description: |
    启动头脑风暴模式（创意产出型）。多Agent按差异化维度并行发散，分层首次收敛，终极二次收敛，共3轮。
    适用场景：创意构思、方案征集、思路拓展、多方案汇总。
    触发条件：用户明确说"头脑风暴一下/发散思考/方案征集"等，或模型判断需要多维度创意发散时调用。
    如果用户未明确指定协作模式但表达了讨论意图，可以先询问用户选择哪种模式。
  parameters:
    type: object
    properties:
      topic:
        type: string
        description: 讨论主题
      participants:
        type: string
        description: 发散层参与者名单（逗号分隔），留空则自动选取3个已启用模型
    required:
      - topic

execution:
  type: module
  module: src/skills/brainstorm.js
---
