import { eq } from 'drizzle-orm'
import { db } from '../mysqlDb/index'
import { chapters } from '../mysqlDb/schema'
import { getPipelineNodeHandler, type PipelineNodeType } from './registry'
import { applyAssetVersionToConfigs } from './shot-assets-store'

export interface RunNodeRequest {
  chapterId: number
  sceneIndex: number
  shotIndex: number
  nodeType: PipelineNodeType
  assetType?: 'first_frame' | 'last_frame' | 'reference_frame' | 'video' | 'tts' | 'compose'
  modelKey?: string
  mode?: string
  params?: Record<string, any>
  /** 可选直接传入章节 configs（如单测或内存态调用），不传则自动从 DB 读取 */
  configs?: any[]
  /** 可选注入自定义生成函数（单测/模拟执行器） */
  generator?: (...args: any[]) => Promise<any>
}

export interface RunNodeResult {
  chapterId: number
  sceneIndex: number
  shotIndex: number
  nodeType: PipelineNodeType
  output: any
  configs?: any[]
}

export interface BatchTargetShot {
  sceneIndex: number
  shotIndex: number
  mode?: string
  params?: Record<string, any>
}

export interface RunSubgraphRequest {
  chapterId: number
  nodeType: 'image' | 'video' | 'audio'
  targets: BatchTargetShot[]
  modelKey?: string
  assetType?: 'first_frame' | 'last_frame' | 'reference_frame'
  concurrency?: number
  configs?: any[]
  generator?: (...args: any[]) => Promise<any>
  onProgress?: (progress: {
    completed: number
    total: number
    sceneIndex: number
    shotIndex: number
    status: 'done' | 'failed'
    error?: string
  }) => void | Promise<void>
}

export interface RunSubgraphResult {
  chapterId: number
  nodeType: 'image' | 'video' | 'audio'
  total: number
  succeeded: number
  failed: number
  results: {
    sceneIndex: number
    shotIndex: number
    status: 'done' | 'failed'
    output?: any
    error?: string
  }[]
  configs?: any[]
}

async function loadChapterConfigsIfNeeded(chapterId: number, provided?: any[]): Promise<any[]> {
  if (Array.isArray(provided)) return provided
  try {
    if (Boolean(process.env.DB_HOST && process.env.DB_NAME) && typeof (db as any)?.select === 'function') {
      const [row] = await db.select().from(chapters).where(eq(chapters.id, chapterId)).limit(1)
      if (row?.content_configs) {
        return typeof row.content_configs === 'string'
          ? JSON.parse(row.content_configs)
          : (Array.isArray(row.content_configs) ? row.content_configs : [])
      }
    }
  } catch {
    // ignore DB load failure in offline mode
  }
  return []
}

async function saveChapterConfigsIfNeeded(chapterId: number, configs: any[], hadInlineConfigs: boolean): Promise<void> {
  if (hadInlineConfigs || !Array.isArray(configs) || configs.length === 0) return
  try {
    if (Boolean(process.env.DB_HOST && process.env.DB_NAME) && typeof (db as any)?.update === 'function') {
      await db.update(chapters)
        .set({ content_configs: configs, updatedAt: new Date() } as any)
        .where(eq(chapters.id, chapterId))
    }
  } catch (err) {
    console.warn(`[scheduler] 写回章节 ${chapterId} content_configs 失败:`, err)
  }
}

function computePanelIdx(configs: any[], sceneIndex: number, shotIndex: number): number {
  let idx = 0
  for (let s = 0; s < configs.length; s++) {
    const shots = Array.isArray(configs[s]?.shots) ? configs[s].shots : []
    if (s === sceneIndex) {
      return idx + shotIndex
    }
    idx += shots.length
  }
  return shotIndex
}

/**
 * 单节点独立执行（runNode）：
 * 只重跑指定 (sceneIndex, shotIndex) 的单个节点（image / video / audio / compose / upscale），
 * 绝不触发或修改其他镜头的数据。
 */
export async function runNode(req: RunNodeRequest): Promise<RunNodeResult> {
  const configs = await loadChapterConfigsIfNeeded(req.chapterId, req.configs)
  const scene = configs[req.sceneIndex]
  const shot = scene?.shots?.[req.shotIndex] || req.params?.shot || {}
  const panelIdx = computePanelIdx(configs, req.sceneIndex, req.shotIndex)
  const handler = getPipelineNodeHandler(req.nodeType)

  let nodeInput: Record<string, any>
  switch (req.nodeType) {
    case 'image':
      nodeInput = {
        chapterId: req.chapterId,
        sceneIndex: req.sceneIndex,
        shotIndex: req.shotIndex,
        assetType: (req.assetType as any) || 'first_frame',
        shot,
        modelKey: req.modelKey || req.params?.modelKey || req.params?.model,
        resolution: req.params?.resolution,
        quality: req.params?.quality,
        aspectRatio: req.params?.aspectRatio,
        prompt: req.params?.prompt,
        negativePrompt: req.params?.negativePrompt,
        stylePrompt: req.params?.stylePrompt || shot.style_prompt_snapshot,
        styleReferenceUrl: req.params?.styleReferenceUrl,
        sceneReference: req.params?.sceneReference,
        propReferences: req.params?.propReferences,
        customRefImages: req.params?.customRefImages,
        generator: req.generator,
      }
      break
    case 'video':
      nodeInput = {
        chapterId: req.chapterId,
        sceneIndex: req.sceneIndex,
        shotIndex: req.shotIndex,
        panelIdx,
        shot,
        modelKey: req.modelKey || req.params?.modelKey || req.params?.model || 'seedance-1.5-pro',
        mode: req.mode || req.params?.mode || shot.gen_mode,
        duration: req.params?.duration ?? shot.durShort,
        resolution: req.params?.resolution,
        quality: req.params?.quality,
        aspectRatio: req.params?.aspectRatio,
        fps: req.params?.fps,
        capability: req.params?.capability,
        generator: req.generator,
      }
      break
    case 'audio':
      nodeInput = {
        chapterId: req.chapterId,
        sceneIndex: req.sceneIndex,
        shotIndex: req.shotIndex,
        shot,
        text: req.params?.text,
        voiceId: req.params?.voiceId,
        emotion: req.params?.emotion,
        tone: req.params?.tone,
        modelKey: req.modelKey || req.params?.modelKey || req.params?.model,
        generator: req.generator,
      }
      break
    case 'compose':
      nodeInput = {
        chapterId: req.chapterId,
        clips: req.params?.clips || req.params?.segments || [],
        width: req.params?.width,
        height: req.params?.height,
        fps: req.params?.fps,
        bgmUrl: req.params?.bgmUrl,
        bgmVolume: req.params?.bgmVolume,
        videoAudioMuted: req.params?.videoAudioMuted,
        videoAudioVolume: req.params?.videoAudioVolume,
        audioTrackMuted: req.params?.audioTrackMuted,
        audioTrackVolume: req.params?.audioTrackVolume,
        composer: req.generator,
      }
      break
    case 'upscale':
      nodeInput = {
        chapterId: req.chapterId,
        sceneIndex: req.sceneIndex,
        shotIndex: req.shotIndex,
        videoUrl: req.params?.videoUrl || req.params?.sourceUrl || shot.finalVideoUrl || shot.videoUrl,
        targetResolution: req.params?.targetResolution || '1080p',
        aspectRatio: req.params?.aspectRatio || '16:9',
        assetType: (req.assetType as any) || 'video',
      }
      break
  }

  const output = await handler.execute(nodeInput)

  let nextConfigs = configs
  if (configs.length > 0 && output?.asset) {
    nextConfigs = applyAssetVersionToConfigs(
      configs,
      req.sceneIndex,
      req.shotIndex,
      output.asset,
    ).configs
    await saveChapterConfigsIfNeeded(req.chapterId, nextConfigs, Boolean(req.configs))
  }

  return {
    chapterId: req.chapterId,
    sceneIndex: req.sceneIndex,
    shotIndex: req.shotIndex,
    nodeType: req.nodeType,
    output,
    ...(req.configs ? { configs: nextConfigs } : {}),
  }
}

/**
 * 批量子图调度（runSubgraph）：
 * 支持勾选若干镜头批量生成关键帧 / 批量生成视频 / 批量生成配音，各镜头独立落库互不污染。
 */
export async function runSubgraph(req: RunSubgraphRequest): Promise<RunSubgraphResult> {
  let currentConfigs = await loadChapterConfigsIfNeeded(req.chapterId, req.configs)
  const total = req.targets.length
  const concurrency = Math.max(1, Math.min(6, Number(req.concurrency || 2)))

  const results: RunSubgraphResult['results'] = new Array(total)
  let cursor = 0
  let completed = 0
  let succeeded = 0
  let failed = 0

  async function worker() {
    while (true) {
      const idx = cursor++
      if (idx >= total) break
      const target = req.targets[idx]!
      try {
        const res = await runNode({
          chapterId: req.chapterId,
          sceneIndex: target.sceneIndex,
          shotIndex: target.shotIndex,
          nodeType: req.nodeType,
          assetType: req.assetType,
          modelKey: req.modelKey,
          mode: target.mode,
          params: target.params,
          configs: currentConfigs,
          generator: req.generator,
        })
        if (res.configs) {
          currentConfigs = res.configs
        }
        succeeded++
        completed++
        results[idx] = {
          sceneIndex: target.sceneIndex,
          shotIndex: target.shotIndex,
          status: 'done',
          output: res.output,
        }
        await req.onProgress?.({
          completed,
          total,
          sceneIndex: target.sceneIndex,
          shotIndex: target.shotIndex,
          status: 'done',
        })
      } catch (err: any) {
        failed++
        completed++
        const message = err instanceof Error ? err.message : String(err)
        results[idx] = {
          sceneIndex: target.sceneIndex,
          shotIndex: target.shotIndex,
          status: 'failed',
          error: message,
        }
        await req.onProgress?.({
          completed,
          total,
          sceneIndex: target.sceneIndex,
          shotIndex: target.shotIndex,
          status: 'failed',
          error: message,
        })
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
  await Promise.all(workers)

  if (succeeded > 0) {
    await saveChapterConfigsIfNeeded(req.chapterId, currentConfigs, Boolean(req.configs))
  }

  return {
    chapterId: req.chapterId,
    nodeType: req.nodeType,
    total,
    succeeded,
    failed,
    results,
    ...(req.configs ? { configs: currentConfigs } : {}),
  }
}
