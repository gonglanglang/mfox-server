import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { generateImageByModel } from '../../imageTools'

/**
 * 图片生成工具（Mastra 外壳）。
 *
 * 协议分发、请求组装、异步轮询、来源校验与 OSS 转存都在 src/imageTools 内完成：
 * 新增供应商只需在后台把服务商的「调用协议」选对（必要时加一个适配器文件），
 * 本工具与上层 workflow 都不需要改动。
 */
export const seedreamTool = createTool({
  id: 'seedream-generate',
  description: '调用已配置的图片模型生成故事素材图片。传入详细英文 prompt，返回图片 URL。',

  inputSchema: z.object({
    prompt: z.string().describe('英文图片生成 prompt，包含素材外观、画面要求、背景、画质标签'),
    model: z.string().optional().describe('图片生成模型标识，对应 ai_models.model'),
    quality: z.string().optional().describe('图片档位（兼容旧调用），例如 1K / 2K / 4K'),
    resolution: z.string().optional().describe('图片档位/尺寸，例如 2K / 2048x2048，需与模型 price_config 的档位对齐'),
    size: z.string().optional().describe('兼容旧调用的图片尺寸参数；未传 resolution 时使用'),
    refImageUrl: z.union([z.array(z.string())]).optional().describe('参考图 URL（单张或数组），用于图生图模式'),
    referenceImages: z.array(z.object({
      url: z.string().describe('参考图 URL'),
      type: z.enum(['style', 'character']).describe('参考图语义：style=风格参考（IP-Adapter/风格迁移），character=角色参考（人物一致性）'),
    })).optional().describe('类型化参考图：style 与 character 语义由适配器映射到供应商参数'),
    seed: z.number().int().optional().describe('随机种子：用于复现同一张图（供应商支持时生效）'),
    outputFormat: z.enum(['png', 'jpeg', 'webp']).optional().default('jpeg').describe('输出图片格式'),
    watermark: z.boolean().optional().default(false).describe('是否添加水印'),
    negativePrompt: z.string().optional().describe('负提示词，用于排除生成的图片中不希望出现的内容'),
    imageCount: z.literal(1).optional().describe('指定只生成一张图片'),
    aspectRatio: z.string().optional().describe('作品宽高比（如 16:9）：与档位一起查表得出像素值，锁定出图比例'),
    label: z.string().optional().describe('用途标签，仅用于 dry run 打印时区分环节（如「分镜首帧」）'),
  }),

  outputSchema: z.object({
    success: z.boolean().describe('是否成功生成图片'),
    imageUrl: z.string().optional().describe('生成的图片 URL'),
    images: z.array(z.string()).optional().describe('生成的图片 URL 数组'),
    error: z.string().optional().describe('图片生成失败的错误信息'),
  }),

  execute: async (inputData) => {
    const { prompt, model, quality, resolution, size, refImageUrl, referenceImages, seed, outputFormat, watermark, negativePrompt, imageCount, aspectRatio, label } = inputData
    try {
      const result = await generateImageByModel({
        model,
        prompt,
        negativePrompt,
        resolution,
        quality,
        size,
        aspectRatio,
        label,
        refImageUrls: refImageUrl || [],
        referenceImages,
        seed,
        outputFormat,
        watermark,
        imageCount: imageCount ?? 1,
        ossPrefix: 'images/personas',
      })
      if (!result.success) return { success: false, error: result.error }
      const urls = result.imageUrls || []
      if (urls.length <= 1) return { success: true, imageUrl: urls[0] || '' }
      return { success: true, images: urls }
    } catch (e: any) {
      return { success: false, error: e.message || '网络请求失败' }
    }
  },
})
