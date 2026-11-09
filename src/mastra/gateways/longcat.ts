import { MastraModelGateway, type ProviderConfig } from '@mastra/core/llm'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV2 } from '@ai-sdk/provider'

export class LongCatGateway extends MastraModelGateway {
  readonly id = 'longcat'
  readonly name = 'LongCat AI Gateway'

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      default: {
        name: 'LongCat',
        models: ['LongCat-2.0'],
        apiKeyEnvVar: 'LONGCAT_API_KEY',
        gateway: this.id,
        url: process.env.LONGCAT_BASE_URL || 'https://api.longcat.ai/v1',
      },
    }
  }

  buildUrl(_modelId: string): string {
    return process.env.LONGCAT_BASE_URL || 'https://api.longcat.ai/v1'
  }

  async getApiKey(): Promise<string> {
    const key = process.env.LONGCAT_API_KEY
    if (!key) throw new Error('缺少 LONGCAT_API_KEY 环境变量')
    return key
  }

  async resolveLanguageModel({
    modelId,
    providerId,
    apiKey,
  }: {
    modelId: string
    providerId: string
    apiKey: string
  }): Promise<LanguageModelV2> {
    const baseURL = this.buildUrl(`${providerId}/${modelId}`)

    const provider = createOpenAI({
      name: providerId,
      apiKey,
      baseURL,
    })

    // ⚠️ 使用 .chat() 而非 .languageModel()
    // @ai-sdk/openai v4 中 .languageModel() 走 Responses API (/v1/responses)
    // LongCat 等第三方兼容 API 只支持 Chat Completions API (/v1/chat/completions)
    return provider.chat(modelId) as unknown as LanguageModelV2
  }
}
