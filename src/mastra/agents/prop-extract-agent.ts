import { Agent } from '@mastra/core/agent'
import { createModelFromContext } from '../../tools/index'

export const PropExtractAgent = new Agent({
  id: 'prop-extract-agent',
  name: '道具信息提取专家',
  model: createModelFromContext as any,
  maxRetries: 5,
  instructions: `从小说原文中提取实际出现、对剧情或画面有意义的道具。
输出 JSON 数组，每项包含 name（不超过100字的名称）、description（50~150 字，包含外形、材质、颜色、状态等可用于绘图的描述）。
同一道具合并，区分不同的独立物品；不要把人物或地点当成道具，不要编造原文没有的物品。
已提供的角色和场景仅作为理解上下文。没有道具时输出 []。只输出 JSON 数组。`,
})