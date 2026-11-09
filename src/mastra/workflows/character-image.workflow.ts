import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { mastra } from '../index'
import { db, schema } from '../../mysqlDb'
import { eq } from 'drizzle-orm'

// ============================================
// 人物形象图生成工作流
// ============================================

const fetchPersona = createStep({
  id: 'fetch-persona',
  inputSchema: z.object({
    personaId: z.number(),
  }),
  outputSchema: z.object({
    personaId: z.number(),
    name: z.string(),
    gender: z.string(),
    age: z.string(),
    description: z.string(),
    images: z.array(z.any()),
    style: z.object({
      name: z.string(),
      description: z.string(),
      effectImage: z.string(),
    }),
  }),
  execute: async ({ inputData }: { inputData: { personaId: number } }) => {
    const { personaId } = inputData
    const [row] = await db.select().from(schema.personas).where(eq(schema.personas.id, personaId))
    if (!row) throw new Error(`人物素材 ${personaId} 不存在`)

    let style = { name: '', description: '', effectImage: '' }
    if (row.work_id) {
      const [work] = await db.select().from(schema.works).where(eq(schema.works.id, row.work_id)).limit(1)
      if (work?.style_id) {
        const [visualStyle] = await db.select()
          .from(schema.visualStyles)
          .where(eq(schema.visualStyles.style_id, work.style_id))
          .limit(1)
        style = {
          name: visualStyle?.name || '',
          description: visualStyle?.description || '',
          effectImage: visualStyle?.effect_image || '',
        }
      }
    }

    return {
      personaId,
      name: row.name,
      gender: row.gender,
      age: row.age || '',
      description: row.description || '',
      images: (row.images as any[]) || [],
      style,
    }
  },
})

const generateImage = createStep({
  id: 'generate-character-image',
  inputSchema: z.object({
    personaId: z.number(),
    name: z.string(),
    gender: z.string(),
    age: z.string(),
    description: z.string(),
    images: z.array(z.any()),
    style: z.object({
      name: z.string(),
      description: z.string(),
      effectImage: z.string(),
    }),
  }),
  outputSchema: z.object({
    personaId: z.number(),
    imageUrl: z.string(),
  }),
  execute: async ({ inputData }: {
    inputData: {
      personaId: number
      name: string
      gender: string
      age: string
      description: string
      images: any[]
      style: { name: string; description: string; effectImage: string }
    }
  }) => {
    const { personaId, name, gender, age, description, style } = inputData

    const agent: any = mastra?.getAgent('CharacterImageAgent')
    if (!agent) throw new Error('Agent character-image-agent 未注册')

    const userPrompt = JSON.stringify({
      assetType: 'persona',
      asset: {
        id: personaId,
        name,
        gender,
        age,
        description,
        refImages: [],
      },
      style,
      generation: {},
    })

    const result: any = await agent.generate(userPrompt)

    const text: string = result.text || ''

    const urlMatch: RegExpMatchArray | null = text.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i)
    const imageUrl: string = urlMatch?.[0] || ''

    if (!imageUrl) throw new Error(`未能从 Agent 响应中提取图片URL：${text.slice(0, 200)}`)

    // 写入数据库
    const newImage = {
      id: Date.now().toString(),
      url: imageUrl,
      type: 'generated',
      job_id: 0, job_status: 'ready',
      edit_job_id: 0, edit_job_status: 'ready',
      prompt: '', parent_image_id: null, ref_images: [],
    }

    const [current]: any[] = await db.select().from(schema.personas).where(eq(schema.personas.id, personaId))
    const existingImages: any[] = (current?.images as any[]) || []
    const updatedImages = [...existingImages, newImage]

    await db.update(schema.personas)
      .set({ images: updatedImages, updatedAt: new Date() } as any)
      .where(eq(schema.personas.id, personaId))

    return { personaId, imageUrl }
  },
})

export const characterImageWorkflow: any = createWorkflow({
  id: 'character-image-generation',
  inputSchema: z.object({
    personaId: z.number(),
  }),
  outputSchema: z.object({
    personaId: z.number(),
    imageUrl: z.string(),
  }),
})
  .then(fetchPersona)
  .then(generateImage)
  .commit()
