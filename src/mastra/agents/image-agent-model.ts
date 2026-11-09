import { createOpenAI } from '@ai-sdk/openai'
import type { RequestContext } from '@mastra/core/request-context'
import { createModelFromContext } from '../../tools/index'

export function getLongCatModel() {
  const baseURL = process.env.LONGCAT_BASE_URL || 'https://api.longcat.ai/v1'
  const apiKey = process.env.LONGCAT_API_KEY || ''
  const provider = createOpenAI({ name: 'longcat', apiKey, baseURL })
  return provider.chat('LongCat-2.0')
}

/** 优先使用请求选择的文本模型；无上下文的旧调用继续使用默认模型。 */
export async function getImageAgentModel({ requestContext }: { requestContext?: RequestContext }) {
  return requestContext?.get('aiModel')
    ? createModelFromContext({ requestContext })
    : getLongCatModel()
}
