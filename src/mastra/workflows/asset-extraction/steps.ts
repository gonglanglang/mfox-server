import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { mastra } from '../../index'
import { db, schema } from '../../../mysqlDb'
import { eq, and, isNull } from 'drizzle-orm'
import { RequestContext } from '@mastra/core/request-context'
import { parseAssetArray, resolveCharacterIds } from '../../../tools/asset-extraction'

// ============================================
// 角色、场景、道具依次提取并入库，角色数据库 ID 传递给后续步骤。
// ============================================

// ---- 各步骤间透传的上下文（角色与场景提取都需要原文 / 归属信息 / 模型上下文） ----
export const coreInputSchema = z.object({
  text: z.string().describe('小说/章节文本内容'),
  workId: z.number().describe('作品 ID'),
  chapterId: z.number().describe('章节 ID'),
  userId: z.number().describe('用户 ID'),
  requestContext: z.instanceof(RequestContext).describe('请求上下文'),
  roles: z.array(z.object({ id: z.number().int(), name: z.string() })).optional(),
})

// ---- 角色 ----
const characterItemSchema = z.object({
  name: z.string().describe('角色名称'),
  gender: z.enum(['male', 'female', 'unknown']).describe('角色性别'),
  age: z.string().describe('角色的年龄段'),
  description: z.string().describe('形象特征描述'),
  voice_id: z.number().int().nullish().describe('语音 ID；语音表为空或无可匹配项时省略'),
})

interface ExtractedCharacter {
  name: string
  gender: 'male' | 'female' | 'unknown'
  age: string
  description: string
  voice_id?: number | null
}

import { retryWithValidation } from '../../../tools/animahub-json'

// 提取角色
export const extractCharacters = createStep({
  id: 'extract-characters',
  inputSchema: coreInputSchema,
  outputSchema: coreInputSchema.extend({
    characters: z.array(characterItemSchema).describe('提取到的角色信息'),
  }),
  execute: async ({ inputData }: {
    inputData: { text: string; workId: number; chapterId: number; userId: number; requestContext: RequestContext }
  }) => {
    const { text, workId, chapterId, userId, requestContext } = inputData
    const agent: any = mastra?.getAgent('CharacterExtractAgent')
    if (!agent) throw new Error('Agent CharacterExtractAgent 未注册')

    const characters = await retryWithValidation(
      async (_attempt, lastError) => {
        const feedback = lastError
          ? `\n【上一轮输出格式未通过校验，请严格修正】：${lastError}\n只输出合法 JSON 数组，不要包含未转义换行符。`
          : ''
        const result = await agent.generate(`
请从以下小说内容中提取所有角色信息，输出 JSON 数组：${feedback}

${text.slice(0, 8000)}
`, { requestContext })
        return result.text || ''
      },
      (raw) => {
        try {
          const parsed = z.array(characterItemSchema).parse(parseAssetArray(raw))
          return { ok: true, value: parsed }
        } catch (err: any) {
          return { ok: false, error: err?.message || '角色数组校验失败' }
        }
      },
      { maxAttempts: 3, baseDelayMs: 300 },
    )
    return { characters, text, workId, chapterId, userId, requestContext }
  },
})

// 保存角色素材（personas.source_type = 'persona'）
export const saveCharacters = createStep({
  id: 'save-characters',
  inputSchema: coreInputSchema.extend({
    characters: z.array(characterItemSchema),
  }),
  outputSchema: coreInputSchema.extend({
    saved: z.number().describe('保存的角色数量'),
  }),
  execute: async ({ inputData }: {
    inputData: { text: string; workId: number; chapterId: number; userId: number; requestContext: RequestContext; characters: ExtractedCharacter[] }
  }) => {
    const { characters, text, workId, chapterId, userId, requestContext } = inputData
    const now = new Date()
    let count = 0

    for (const ch of characters) {
      // 检查同名角色是否已存在（本作品维度，避免跨章节重复入库）
      const [existing] = await db.select()
        .from(schema.personas)
        .where(and(eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId), eq(schema.personas.source_type, 'persona'), eq(schema.personas.name, ch.name), isNull(schema.personas.deleted_at)))
        .limit(1)
      if (existing) continue

      await db.insert(schema.personas).values({
        work_id: workId,
        chapters_id: chapterId,
        user_id: userId,
        name: ch.name,
        voice_id: ch.voice_id ?? null,
        source_type: 'persona',
        gender: ch.gender,
        age: ch.age,
        description: ch.description,
        images: [],
        images_history: [],
        ref_images: [],
        createdAt: now,
        updatedAt: now,
      } as any)
      count++
    }
    const roles = await db.select({ id: schema.personas.id, name: schema.personas.name }).from(schema.personas)
      .where(and(eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId), eq(schema.personas.source_type, 'persona'), isNull(schema.personas.deleted_at)))
    return { saved: count, text, workId, chapterId, userId, requestContext, roles }
  },
})

// ---- 场景 ----
const sceneItemSchema = z.object({
  id: z.number().optional().describe('场景序号'),
  title: z.string().optional().describe('场景标题'),
  time: z.string().optional().describe('时间描述'),
  location: z.string().optional().describe('地点名称'),
  interior: z.boolean().optional().describe('室内/室外'),
  characters: z.array(z.union([z.number().int().positive(), z.string()])).optional().describe('出场角色数据库 ID'),
  description: z.string().optional().describe('场景环境描写'),
  mood: z.string().optional().describe('整体情绪氛围'),
  key_events: z.string().optional().describe('关键事件或核心对话摘要'),
})

const normalizedSceneItemSchema = sceneItemSchema.extend({
  characters: z.array(z.number().int().positive()).optional(),
})

interface ExtractedScene {
  id?: number
  title?: string
  time?: string
  location?: string
  interior?: boolean
  characters?: number[]
  description?: string
  mood?: string
  key_events?: string
}

// 提取场景（基于同一段原文，在角色提取完成后执行）
export const extractScene = createStep({
  id: 'extract-scene',
  inputSchema: coreInputSchema,
  outputSchema: coreInputSchema.extend({
    scenes: z.array(normalizedSceneItemSchema).describe('提取到的场景信息'),
  }),
  execute: async ({ inputData }: {
    inputData: z.infer<typeof coreInputSchema>
  }) => {
    const { text, requestContext } = inputData
    const agent: any = mastra?.getAgent('SceneExtractAgent')
    if (!agent) throw new Error('Agent SceneExtractAgent 未注册')

    let currentAttempt = 0
    const scenes = await retryWithValidation(
      async (attempt, lastError) => {
        currentAttempt = attempt
        const feedback = lastError
          ? `\n【上一轮输出未通过校验，请修正】：${lastError}\ncharacters 只能填写上方可用角色列表中的数字 id，禁止填写未收录路人或无效编号。`
          : ''
        const result = await agent.generate(`
请从以下小说/章节内容中提取所有独立场景，输出 JSON 数组：
可用角色（characters 只能使用这些角色的数字 id）：${JSON.stringify(inputData.roles || [])}${feedback}

${text.slice(0, 8000)}
`, { requestContext })
        return result.text || ''
      },
      (raw) => {
        try {
          const parsed = z.array(sceneItemSchema).parse(parseAssetArray(raw))
          const normalized: z.infer<typeof normalizedSceneItemSchema>[] = []
          for (const scene of parsed) {
            const rawChars = (scene.characters || []).map(v =>
              typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v,
            )
            const resolved = resolveCharacterIds(rawChars, inputData.roles || [])
            if (resolved.unresolved.length > 0 && currentAttempt < 2) {
              return {
                ok: false,
                error: `场景「${scene.title || scene.location || ''}」引用了不在可用角色表中的角色 ID/名称：${JSON.stringify(resolved.unresolved)}`,
              }
            }
            if (resolved.unresolved.length > 0) {
              console.warn(`[extract-scene] 已自动过滤未收录次要角色引用: ${JSON.stringify(resolved.unresolved)}`)
            }
            normalized.push({ ...scene, characters: resolved.ids })
          }
          return { ok: true, value: normalized }
        } catch (err: any) {
          return { ok: false, error: err?.message || '场景数组校验失败' }
        }
      },
      { maxAttempts: 3, baseDelayMs: 300 },
    )
    return { ...inputData, scenes }
  },
})

// 保存场景素材（personas.source_type = 'scene'，结构化字段存 detail JSON 列）
export const saveScenes = createStep({
  id: 'save-scenes',
  inputSchema: coreInputSchema.extend({
    scenes: z.array(normalizedSceneItemSchema),
  }),
  outputSchema: coreInputSchema.extend({
    saved: z.number().describe('保存的场景数量'),
  }),
  execute: async ({ inputData }: {
    inputData: z.infer<typeof coreInputSchema> & { scenes: ExtractedScene[] }
  }) => {
    const { scenes, workId, chapterId, userId } = inputData
    const now = new Date()
    let count = 0

    for (const scene of scenes) {
      const name = (scene.title || scene.location || `场景 ${scene.id ?? count + 1}`).slice(0, 100)
      // 同章节 + 同名场景已存在则跳过，避免重复素材
      const [existing] = await db.select({ id: schema.personas.id, detail: schema.personas.detail })
        .from(schema.personas)
        .where(and(
          eq(schema.personas.work_id, workId),
          eq(schema.personas.user_id, userId),
          eq(schema.personas.chapters_id, chapterId),
          eq(schema.personas.source_type, 'scene'),
          eq(schema.personas.name, name),
          isNull(schema.personas.deleted_at),
        ))
        .limit(1)
      if (existing) {
        const detail = existing.detail && typeof existing.detail === 'object' ? existing.detail : {}
        await db.update(schema.personas).set({ detail: { ...detail, characters: scene.characters || [] }, updatedAt: now })
          .where(eq(schema.personas.id, existing.id))
        continue
      }

      await db.insert(schema.personas).values({
        work_id: workId,
        chapters_id: chapterId,
        user_id: userId,
        name,
        source_type: 'scene',
        description: scene.description || '',
        detail: scene as Record<string, any>, // 完整结构化字段，供前端/后续流程按字段读取
        images: [],
        images_history: [],
        ref_images: [],
        createdAt: now,
        updatedAt: now,
      } as any)
      count++
    }
    return { ...inputData, saved: count }
  },
})

const propSchema = z.object({ name: z.string().min(1).max(100), description: z.string() })
export const extractProps = createStep({
  id: 'extract-props',
  inputSchema: coreInputSchema,
  outputSchema: coreInputSchema.extend({ props: z.array(propSchema) }),
  execute: async ({ inputData }) => {
    const scenes = await db.select({ id: schema.personas.id, name: schema.personas.name, detail: schema.personas.detail })
      .from(schema.personas).where(and(eq(schema.personas.work_id, inputData.workId),
        eq(schema.personas.user_id, inputData.userId), eq(schema.personas.chapters_id, inputData.chapterId), eq(schema.personas.source_type, 'scene'), isNull(schema.personas.deleted_at)))
    const props = await retryWithValidation(
      async (_attempt, lastError) => {
        const feedback = lastError
          ? `\n【上一轮输出格式未通过校验，请修正】：${lastError}\n只输出合法 JSON 数组 [{ "name": "...", "description": "..." }]。`
          : ''
        const result = await mastra.getAgent('PropExtractAgent').generate(
          `角色：${JSON.stringify(inputData.roles || [])}\n场景：${JSON.stringify(scenes)}${feedback}\n小说原文：\n${inputData.text.slice(0, 8000)}`,
          { requestContext: inputData.requestContext },
        )
        return result.text || ''
      },
      (raw) => {
        try {
          return { ok: true, value: z.array(propSchema).parse(parseAssetArray(raw)) }
        } catch (err: any) {
          return { ok: false, error: err?.message || '道具数组校验失败' }
        }
      },
      { maxAttempts: 3, baseDelayMs: 300 },
    )
    return { ...inputData, props }
  },
})

export const saveProps = createStep({
  id: 'save-props',
  inputSchema: coreInputSchema.extend({ props: z.array(propSchema) }),
  outputSchema: z.object({ saved: z.number() }),
  execute: async ({ inputData }) => {
    const { workId, chapterId, userId } = inputData
    let saved = 0
    for (const prop of inputData.props) {
      const [existing] = await db.select({ id: schema.personas.id }).from(schema.personas)
        .where(and(eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId),
          eq(schema.personas.source_type, 'prop'), eq(schema.personas.name, prop.name), isNull(schema.personas.deleted_at))).limit(1)
      if (existing) continue
      const now = new Date()
      await db.insert(schema.personas).values({ ...prop, work_id: workId, chapters_id: chapterId,
        user_id: userId, source_type: 'prop', createdAt: now, updatedAt: now })
      saved++
    }
    return { saved }
  },
})

// 单类提取复用已入库角色，避免重复调用角色 Agent。
export const loadAssetContext = createStep({
  id: 'load-asset-context',
  inputSchema: coreInputSchema,
  outputSchema: coreInputSchema,
  execute: async ({ inputData }) => {
    const roles = await db.select({ id: schema.personas.id, name: schema.personas.name })
      .from(schema.personas).where(and(eq(schema.personas.work_id, inputData.workId),
        eq(schema.personas.user_id, inputData.userId), eq(schema.personas.source_type, 'persona'), isNull(schema.personas.deleted_at)))
    return { ...inputData, roles }
  },
})
