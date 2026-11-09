import { z } from 'zod'
import { normalizeShotLink } from '../../../tools/storyboard-text'

export interface ShotFrameSpan {
  shotIndex: number
  startFrameIndex: number
  endFrameIndex: number
  /** 本镜尾帧是否与下一镜首帧共享同一帧节点（仅当下一镜存在且 link.type === 'continuous' 时为 true） */
  sharesEndWithNext: boolean
}

/**
 * 计算场景内每个镜头的首尾帧索引映射：
 * - 当下一镜 link.type === 'continuous'（默认）时，本镜尾帧与下一镜首帧共享同一个 frame_index；
 * - 当下一镜 link.type !== 'continuous'（cut / transition）或本镜为场景最后一镜时，
 *   本镜拥有独立的尾帧节点（endFrameIndex），下一镜从新的 startFrameIndex 独立起幅，
 *   防止切镜时把下一镜全新机位的首帧错误当成本镜的尾帧。
 */
export function resolveShotFrameIndices(shots: Record<string, any>[]): ShotFrameSpan[] {
  const spans: ShotFrameSpan[] = []
  let nextFrameIndex = 0
  for (let i = 0; i < shots.length; i++) {
    const prevSpan = i > 0 ? spans[i - 1] : undefined
    const startFrameIndex = prevSpan && prevSpan.sharesEndWithNext
      ? prevSpan.endFrameIndex
      : nextFrameIndex++
    const endFrameIndex = nextFrameIndex++
    const sharesEndWithNext = i + 1 < shots.length
      && normalizeShotLink(shots[i + 1] || {}).type === 'continuous'
    spans.push({
      shotIndex: i,
      startFrameIndex,
      endFrameIndex,
      sharesEndWithNext,
    })
  }
  return spans
}

const framePromptSchema = z.string().trim().min(1)

/** 场景内一批关键帧的渲染结果（frame_index 为场景内索引；一批 N 个镜头对应 N+1 个帧）。 */
const renderedBatchSchema = z.object({
  scene_id: z.union([z.string(), z.number()]),
  frames: z.array(z.object({
    frame_index: z.number().int().nonnegative(),
    prompt: framePromptSchema,
    negative_prompt: z.string().optional().default(''),
  })),
})

/**
 * 瞬时姿态/门窗开合/单帧动作完成度等"只对某一帧成立"的负面词正则。
 * 若把这类负面词合入镜头级 negative_prompt 或视频 prompt 的「避免出现」，
 * 会导致"首帧要求站立、避免出现却禁止站立"或"首帧无执事、避免出现却禁止执事缺失"的自相矛盾。
 */
const TRANSIENT_NEGATIVE_CLAUSE_RE =
  /仍站立|未跌坐|仍坐姿|仍贴地|仍跪|仍趴|完全站直|未起身|门板.*敞开|门板.*紧闭|门板.*关闭|执事身影缺失|执事身影.*入画|水花缺失|泥水.*缺失|动作已完成|动作未开始/

/**
 * 清洗并去重镜头级负面提示词：
 * 1. 按中英文分号/逗号切分子句并去重；
 * 2. 剔除只针对单帧瞬时姿态或门窗开合状态的矛盾禁令，仅保留跨帧恒定的身份、画风、比例、道具与画质排除项。
 */
export function sanitizeShotNegativePrompt(...parts: (string | undefined | null)[]): string {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of parts) {
    const clauses = String(part || '')
      .split(/[；;。]+/)
      .map(s => s.trim())
      .filter(Boolean)
    for (const clause of clauses) {
      if (TRANSIENT_NEGATIVE_CLAUSE_RE.test(clause)) continue
      if (seen.has(clause)) continue
      seen.add(clause)
      result.push(clause)
    }
  }
  return result.join('；')
}

/**
 * 清洗视频生成 prompt 末尾「避免出现：……」中的瞬时姿态矛盾项与重复子句。
 */
export function sanitizeVideoPromptAvoidClause(prompt: string): string {
  const raw = String(prompt || '')
  return raw.replace(/(避免出现[：:])([\s\S]*)$/u, (_match, prefix: string, body: string) => {
    const trailingDot = /[。.]\s*$/.test(body) ? '。' : ''
    const cleaned = sanitizeShotNegativePrompt(body.replace(/[。.]\s*$/, ''))
    return cleaned ? `${prefix}${cleaned}${trailingDot}` : ''
  }).trim()
}

/**
 * 把渲染器返回的一批关键帧写回指定场景：只接受批内索引，校验 8 段格式。
 *
 * 一批 N 个镜头需要 N+1 个帧——第 i 镜从帧 i 演到帧 i+1，所以它的 start_prompt 与
 * end_prompt 分别来自相邻两个帧（同一个帧被相邻两镜共用）。帧状态（content）已在
 * 渲染前确定，这里只做格式与归属校验，不做语义判断；不修改入参。
 */
export function applyRenderedShots<T extends { scene_id: string | number; shots: Record<string, any>[] }>(
  configs: T[],
  batch: { sceneIndex: number; batchStart: number; batchSize: number },
  value: unknown,
  cachedFrames?: Map<number, { prompt: string; negative_prompt: string }>,
): T[] {
  const { sceneIndex, batchStart, batchSize } = batch
  const scene = configs[sceneIndex]
  if (!scene) throw new Error(`渲染结果对应的场景不存在：${sceneIndex}`)
  if (!Number.isSafeInteger(batchStart) || batchStart < 0 || !Number.isSafeInteger(batchSize) || batchSize <= 0
    || batchStart + batchSize > scene.shots.length) {
    throw new Error(`渲染批次越界：场景 ${sceneIndex} 共 ${scene.shots.length} 个镜头，请求 [${batchStart}, ${batchStart + batchSize})`)
  }
  const parsed = renderedBatchSchema.safeParse(value)
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 3)
      .map(issue => `${issue.path.join('.') || 'result'}: ${issue.message}`).join('；')
    throw new Error(`渲染结果格式错误：${details}`)
  }
  const { scene_id, frames } = parsed.data
  if (String(scene_id) !== String(scene.scene_id)) {
    throw new Error(`渲染结果的场景不匹配：期望 ${scene.scene_id}，实际 ${scene_id}`)
  }
  const spans = resolveShotFrameIndices(scene.shots)
  const batchSpans = spans.slice(batchStart, batchStart + batchSize)
  const expectedFrameIndices = new Set<number>()
  for (const span of batchSpans) {
    expectedFrameIndices.add(span.startFrameIndex)
    expectedFrameIndices.add(span.endFrameIndex)
  }
  const unrenderedFrameIndices = new Set<number>(
    [...expectedFrameIndices].filter(idx => !cachedFrames?.has(idx)),
  )
  const expectedFrames = unrenderedFrameIndices.size
  if (frames.length !== expectedFrames) {
    throw new Error(`渲染结果帧数量应为 ${expectedFrames}，实际 ${frames.length}`)
  }
  const rendered = new Map<number, { prompt: string; negative_prompt: string }>(cachedFrames)
  const seenInBatch = new Set<number>()
  for (const { frame_index, ...fields } of frames) {
    if (!unrenderedFrameIndices.has(frame_index)) {
      throw new Error(`渲染结果包含批外帧索引：${frame_index}`)
    }
    if (seenInBatch.has(frame_index)) throw new Error(`渲染结果帧索引重复：${frame_index}`)
    seenInBatch.add(frame_index)
    rendered.set(frame_index, fields)
  }
  const nextConfigs = configs.map((config, index) => index !== sceneIndex ? config : ({
    ...config,
    shots: config.shots.map((shot, shotIndex) => {
      if (shotIndex < batchStart || shotIndex >= batchStart + batchSize) return shot
      const span = spans[shotIndex]
      if (!span) return shot
      const head = rendered.get(span.startFrameIndex)
      const tail = rendered.get(span.endFrameIndex)
      if (!head || !tail) return shot
      // 合并负面词时去重并剔除只对单帧成立的瞬时姿态禁令，防止首尾帧及视频正反向提示词自相矛盾
      const negative_prompt = sanitizeShotNegativePrompt(tail.negative_prompt, head.negative_prompt)
      const existingImagePrompt = typeof (shot as any)?.image_prompt === 'string' ? (shot as any).image_prompt.trim() : ''
      return {
        ...shot,
        start_prompt: head.prompt,
        end_prompt: tail.prompt,
        negative_prompt,
        image_prompt: existingImagePrompt || head.prompt,
      }
    }),
  } as T))
  if (cachedFrames) {
    for (const { frame_index, ...fields } of frames) {
      cachedFrames.set(frame_index, fields)
    }
  }
  return nextConfigs
}
