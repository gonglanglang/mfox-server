import express from 'express'
import { and, eq } from 'drizzle-orm'
import { RequestContext } from '@mastra/core/request-context'
import { db, schema } from '../mysqlDb'
import { success, error } from '../tools/response'
import { runNode, runSubgraph } from '../pipeline/scheduler'
import {
  applyAssetVersionToConfigs,
  listShotAssetVersions,
  selectShotAssetVersion,
  type ShotAssetRecord,
  type ShotAssetType,
} from '../pipeline/shot-assets-store'
import { resolveCapability, VIDEO_MODE_LABELS, ALL_VIDEO_MODES } from '../pipeline/model-schema'
import { upscaleVideo } from '../videoTools/upscale'
import type { PipelineNodeType } from '../pipeline/registry'
import { hydrateFrameUrls } from '../tools/frame-pool'
import { loadStoryboardEvidence } from '../tools/storyboard-evidence'
import {
  buildPropCard,
  buildSceneCard,
  DEFAULT_STYLE_PROMPT,
  loadWorkStyleProfile,
} from '../tools/storyboard-assets'
import { retryWithValidation, stripLeadingStylePrefix } from '../tools/animahub-json'
import {
  buildContextualInferencePromptPayload,
  inferEndFramePromptDeterministic,
  parseContextualInferenceResult,
  synthesizeMotionPromptDeterministic,
  type InferredShotPrompts,
} from '../tools/animahub-storyboard'

const router = express.Router()

const VALID_NODE_TYPES = new Set<PipelineNodeType>(['image', 'video', 'audio', 'compose', 'upscale'])
const VALID_ASSET_TYPES = new Set<ShotAssetType>([
  'first_frame',
  'last_frame',
  'reference_frame',
  'video',
  'tts',
  'compose',
])

export interface ResolvedShotPosition {
  panelIdx: number
  sceneIndex: number
  shotIndex: number
}

/**
 * 双向解析 `panelIdx` 与 `(sceneIndex, shotIndex)`，兼容前端传 `panelIdx` 与后端直接传 `(sceneIndex, shotIndex)`。
 */
export function resolveShotPosition(
  configs: any[],
  input: { panelIdx?: unknown; sceneIndex?: unknown; shotIndex?: unknown },
): ResolvedShotPosition {
  const hasExplicitSceneShot = input.sceneIndex !== undefined && input.shotIndex !== undefined
  const rawPanelIdx = input.panelIdx !== undefined && input.panelIdx !== null && input.panelIdx !== ''
    ? Number(input.panelIdx)
    : NaN

  if (!hasExplicitSceneShot && Number.isSafeInteger(rawPanelIdx) && rawPanelIdx >= 0) {
    let cursor = 0
    for (let s = 0; s < configs.length; s++) {
      const shots = Array.isArray(configs[s]?.shots) ? configs[s].shots : null
      if (shots) {
        if (rawPanelIdx < cursor + shots.length) {
          return {
            panelIdx: rawPanelIdx,
            sceneIndex: s,
            shotIndex: rawPanelIdx - cursor,
          }
        }
        cursor += shots.length
      } else {
        if (cursor === rawPanelIdx) {
          return { panelIdx: rawPanelIdx, sceneIndex: 0, shotIndex: rawPanelIdx }
        }
        cursor += 1
      }
    }
    return { panelIdx: rawPanelIdx, sceneIndex: 0, shotIndex: rawPanelIdx }
  }

  const scIdx = Math.max(0, Number.isSafeInteger(Number(input.sceneIndex)) ? Number(input.sceneIndex) : 0)
  const shIdx = Math.max(0, Number.isSafeInteger(Number(input.shotIndex)) ? Number(input.shotIndex) : 0)
  let computedPanelIdx = Number.isSafeInteger(rawPanelIdx) && rawPanelIdx >= 0 ? rawPanelIdx : 0
  if (!(Number.isSafeInteger(rawPanelIdx) && rawPanelIdx >= 0)) {
    let acc = 0
    for (let s = 0; s < configs.length; s++) {
      const shots = Array.isArray(configs[s]?.shots) ? configs[s].shots : []
      if (s === scIdx) {
        computedPanelIdx = acc + shIdx
        break
      }
      acc += shots.length
    }
  }
  return { panelIdx: computedPanelIdx, sceneIndex: scIdx, shotIndex: shIdx }
}

/**
 * 将内部 `ShotAssetRecord` 归一化为前端 `ShotAssetVersionItem` 契约（同时保留旧字段以兼容全部调用方）。
 */
export function formatVersionForClient(record: ShotAssetRecord, workId = 0) {
  const clientStatus: 'running' | 'completed' | 'failed' =
    record.status === 'done'
      ? 'completed'
      : record.status === 'failed'
        ? 'failed'
        : 'running'
  const createdAt = record.created_at instanceof Date
    ? record.created_at.toISOString()
    : String(record.created_at || '')
  return {
    ...record,
    work_id: workId,
    model: record.model_key,
    status: clientStatus,
    raw_status: record.status,
    cost: Number(record.params?.cost || 0),
    createdAt,
  }
}

async function loadChapterRow(chapterId: number, workId?: number) {
  try {
    const conds = [eq(schema.chapters.id, chapterId)]
    if (workId && Number.isSafeInteger(workId) && workId > 0) {
      conds.push(eq(schema.chapters.work_id, workId))
    }
    const [row] = await db.select().from(schema.chapters).where(and(...conds)).limit(1)
    if (!row) return { row: null, configs: [] as any[] }
    const rawConfigs = typeof row.content_configs === 'string'
      ? JSON.parse(row.content_configs)
      : (Array.isArray(row.content_configs) ? row.content_configs : [])
    return { row, configs: hydrateFrameUrls(rawConfigs) }
  } catch {
    return { row: null, configs: [] as any[] }
  }
}

async function buildFusionParamsForScene(options: {
  workId?: number
  chapterId: number
  userId?: number
  styleId?: number | null
  configs: any[]
  sceneIndex: number
}) {
  const out: Record<string, any> = {}
  const { workId, chapterId, userId, styleId, configs, sceneIndex } = options
  if (!workId) return out

  try {
    if (styleId && Number(styleId) > 0) {
      const [st] = await db
        .select({
          description: schema.visualStyles.description,
          effectImage: schema.visualStyles.effect_image,
        })
        .from(schema.visualStyles)
        .where(eq(schema.visualStyles.style_id, Number(styleId)))
        .limit(1)
      if (st) {
        out.stylePrompt = String(st.description || '').trim() || DEFAULT_STYLE_PROMPT
        out.styleReferenceUrl = String(st.effectImage || '').trim() || undefined
      }
    }
    if (!out.stylePrompt && userId) {
      const sp = await loadWorkStyleProfile({ workId, userId })
      out.stylePrompt = sp.prompt
      out.styleReferenceUrl = sp.referenceUrl || undefined
    }
    const [workRow] = await db
      .select({ aspectRatio: schema.works.aspect_ratio })
      .from(schema.works)
      .where(eq(schema.works.id, workId))
      .limit(1)
    if (workRow?.aspectRatio) {
      out.aspectRatio = workRow.aspectRatio
    }

    if (userId && configs[sceneIndex]) {
      const sc = configs[sceneIndex]
      const evidence = await loadStoryboardEvidence({ workId, chapterId, userId }, [sc])
      const assets = evidence.assets || []
      const sceneAsset = assets.find((a: any) => a.type === 'scene' && String(a.id) === String(sc.scene_id))
      const sceneCard = sceneAsset ? buildSceneCard(sceneAsset) : null
      if (sceneCard) {
        out.sceneReference = {
          id: sceneCard.id,
          text: sceneCard.text,
          imageUrl: sceneCard.imageUrl,
        }
      }
      const propIds: any[] = Array.isArray(sc.prop_ids) ? sc.prop_ids : []
      out.propReferences = propIds
        .map(pid => {
          const pa = assets.find((a: any) => a.type === 'prop' && String(a.id) === String(pid))
          const card = pa ? buildPropCard(pa) : null
          return card
            ? { id: card.id, name: pa?.name || String(card.id), text: card.text, imageUrl: card.imageUrl }
            : null
        })
        .filter(Boolean)
    }
  } catch {
    // non-fatal enrichment failure
  }
  return out
}

/**
 * POST /pipeline/node/run
 * 单节点独立执行（重跑某镜头的图片、视频、配音、合成或超分节点，不触碰其他镜头）
 */
router.post('/node/run', async (req, res) => {
  try {
    const {
      workId,
      chapterId,
      panelIdx,
      sceneIndex,
      shotIndex,
      nodeType,
      assetType,
      model,
      modelKey,
      resolution,
      styleId,
      frameMode,
      genMode,
      mode,
      params = {},
    } = req.body || {}

    const chId = Number(chapterId)
    if (!Number.isSafeInteger(chId) || chId <= 0) {
      return error(res, 'chapterId 必须为正整数', 400)
    }
    if (!VALID_NODE_TYPES.has(nodeType)) {
      return error(res, `不支持的节点类型: ${String(nodeType)}`, 400)
    }

    const userId = Number((req as any).user?.id || 0) || undefined
    const wId = workId ? Number(workId) : undefined
    const { row: chapterRow, configs } = await loadChapterRow(chId, wId)
    const effectiveWorkId = wId || Number(chapterRow?.work_id || 0) || undefined
    const pos = resolveShotPosition(configs, { panelIdx, sceneIndex, shotIndex })

    const effectiveModel = String(
      modelKey || model || req.headers['aimodel'] || params?.modelKey || params?.model || '',
    ).trim() || undefined
    const effectiveMode = String(mode || genMode || params?.mode || '').trim() || undefined

    let fusionExtras: Record<string, any> = {}
    if (nodeType === 'image') {
      fusionExtras = await buildFusionParamsForScene({
        workId: effectiveWorkId,
        chapterId: chId,
        userId: userId || Number(chapterRow?.user_id || 0) || undefined,
        styleId,
        configs,
        sceneIndex: pos.sceneIndex,
      })
    }

    const mergedParams = {
      ...fusionExtras,
      ...params,
      ...(resolution ? { resolution } : {}),
      ...(frameMode ? { frameMode } : {}),
    }

    const result = await runNode({
      chapterId: chId,
      sceneIndex: pos.sceneIndex,
      shotIndex: pos.shotIndex,
      nodeType,
      assetType,
      modelKey: effectiveModel,
      mode: effectiveMode,
      params: mergedParams,
    })

    // 若 frameMode === 'dual' 且为生图节点未显式指定 assetType，顺带生成尾帧候选版本
    if (nodeType === 'image' && !assetType && frameMode === 'dual') {
      await runNode({
        chapterId: chId,
        sceneIndex: pos.sceneIndex,
        shotIndex: pos.shotIndex,
        nodeType: 'image',
        assetType: 'last_frame',
        modelKey: effectiveModel,
        params: mergedParams,
      }).catch(err => console.warn(`[pipeline/node/run] dual 尾帧生成跳过: ${err?.message || err}`))
    }

    const outAsset = result.output?.asset as ShotAssetRecord | undefined
    return success(res, {
      nodeId: `${nodeType}-${chId}-${pos.panelIdx}`,
      ...result,
      panelIdx: pos.panelIdx,
      status: 'completed' as const,
      assetId: outAsset?.id,
      version: result.output?.version ?? outAsset?.version,
      url: result.output?.url ?? result.output?.videoUrl ?? result.output?.audioUrl ?? outAsset?.url ?? '',
    })
  } catch (e: any) {
    return error(res, e?.message || '节点执行失败')
  }
})

/**
 * POST /pipeline/batch/run
 * 批量子图调度（兼容前端 `panelIdxes: number[]` 与底层 `targets: { sceneIndex, shotIndex }[]`）
 */
router.post('/batch/run', async (req, res) => {
  try {
    const {
      workId,
      chapterId,
      nodeType,
      targets,
      panelIdxes,
      model,
      modelKey,
      resolution,
      styleId,
      frameMode,
      genMode,
      assetType,
      concurrency,
    } = req.body || {}

    const chId = Number(chapterId)
    if (!Number.isSafeInteger(chId) || chId <= 0) {
      return error(res, 'chapterId 必须为正整数', 400)
    }
    if (!['image', 'video', 'audio'].includes(String(nodeType))) {
      return error(res, '批量执行仅支持 image / video / audio 节点', 400)
    }

    const userId = Number((req as any).user?.id || 0) || undefined
    const wId = workId ? Number(workId) : undefined
    const { row: chapterRow, configs } = await loadChapterRow(chId, wId)
    const effectiveWorkId = wId || Number(chapterRow?.work_id || 0) || undefined
    const effectiveUserId = userId || Number(chapterRow?.user_id || 0) || undefined
    const effectiveModel = String(modelKey || model || req.headers['aimodel'] || '').trim() || undefined

    const rawList: any[] = Array.isArray(targets) && targets.length > 0
      ? targets
      : Array.isArray(panelIdxes) && panelIdxes.length > 0
        ? panelIdxes.map((pIdx: any) => ({ panelIdx: Number(pIdx) }))
        : []

    if (rawList.length === 0) {
      return error(res, '请至少勾选 1 个目标镜头', 400)
    }

    // 按场次缓存融合参考图上下文，避免重复查库
    const sceneFusionCache = new Map<number, Record<string, any>>()
    const resolvedPositions: ResolvedShotPosition[] = []
    const normalizedTargets = []

    for (const item of rawList) {
      const pos = resolveShotPosition(configs, {
        panelIdx: item?.panelIdx,
        sceneIndex: item?.sceneIndex,
        shotIndex: item?.shotIndex,
      })
      resolvedPositions.push(pos)

      let sceneExtras: Record<string, any> = {}
      if (nodeType === 'image') {
        if (!sceneFusionCache.has(pos.sceneIndex)) {
          sceneFusionCache.set(
            pos.sceneIndex,
            await buildFusionParamsForScene({
              workId: effectiveWorkId,
              chapterId: chId,
              userId: effectiveUserId,
              styleId,
              configs,
              sceneIndex: pos.sceneIndex,
            }),
          )
        }
        sceneExtras = sceneFusionCache.get(pos.sceneIndex) || {}
      }

      normalizedTargets.push({
        sceneIndex: pos.sceneIndex,
        shotIndex: pos.shotIndex,
        mode: item?.mode || genMode,
        params: {
          ...sceneExtras,
          ...(item?.params || {}),
          ...(resolution ? { resolution } : {}),
          ...(frameMode ? { frameMode } : {}),
        },
      })
    }

    const batchRes = await runSubgraph({
      chapterId: chId,
      nodeType,
      targets: normalizedTargets,
      modelKey: effectiveModel,
      assetType,
      concurrency: concurrency ? Number(concurrency) : 2,
    })

    const mappedResults = batchRes.results.map((r, idx) => {
      const pos = resolvedPositions[idx] || { panelIdx: idx, sceneIndex: r.sceneIndex, shotIndex: r.shotIndex }
      const outAsset = r.output?.asset as ShotAssetRecord | undefined
      return {
        nodeId: `${nodeType}-${chId}-${pos.panelIdx}`,
        panelIdx: pos.panelIdx,
        sceneIndex: r.sceneIndex,
        shotIndex: r.shotIndex,
        status: (r.status === 'done' ? 'completed' : 'failed') as 'completed' | 'failed',
        version: r.output?.version ?? outAsset?.version,
        url: r.output?.url ?? r.output?.videoUrl ?? r.output?.audioUrl ?? outAsset?.url,
        output: r.output,
        ...(r.error ? { error: r.error } : {}),
      }
    })

    return success(res, {
      chapterId: chId,
      nodeType,
      total: batchRes.total,
      completed: batchRes.succeeded,
      succeeded: batchRes.succeeded,
      failed: batchRes.failed,
      results: mappedResults,
    })
  } catch (e: any) {
    return error(res, e?.message || '批量执行失败')
  }
})

/**
 * GET /pipeline/node/versions
 * 查询某镜头（支持 `panelIdx` 或 `sceneIndex + shotIndex`）的全部历史候选版本
 */
router.get('/node/versions', async (req, res) => {
  try {
    const chId = Number(req.query.chapterId)
    const wId = req.query.workId ? Number(req.query.workId) : 0
    const assetTypeRaw = req.query.assetType ? String(req.query.assetType).trim() : undefined

    if (!Number.isSafeInteger(chId) || chId <= 0) {
      return error(res, 'chapterId 必须为正整数', 400)
    }
    if (assetTypeRaw && !VALID_ASSET_TYPES.has(assetTypeRaw as ShotAssetType)) {
      return error(res, `不支持的资产类型: ${assetTypeRaw}`, 400)
    }

    const { row: chapterRow, configs } = await loadChapterRow(chId, wId || undefined)
    const effectiveWorkId = wId || Number(chapterRow?.work_id || 0)
    const pos = resolveShotPosition(configs, {
      panelIdx: req.query.panelIdx,
      sceneIndex: req.query.sceneIndex,
      shotIndex: req.query.shotIndex,
    })

    const records = await listShotAssetVersions({
      chapterId: chId,
      sceneIndex: pos.sceneIndex,
      shotIndex: pos.shotIndex,
      assetType: assetTypeRaw as ShotAssetType | undefined,
    })

    // 若 shot_assets 表尚无历史记录，但当前分镜已有首帧/尾帧/视频，自动合成 v1 当前项以便前端抽屉直观展示
    const formatted = records.map(r => formatVersionForClient(r, effectiveWorkId))
    if (formatted.length === 0) {
      const curShot = configs[pos.sceneIndex]?.shots?.[pos.shotIndex]
      if (curShot) {
        const fallbackEntries: Array<{ type: ShotAssetType; url: string; prompt?: string }> = []
        if ((!assetTypeRaw || assetTypeRaw === 'first_frame') && curShot.firstFrameUrl) {
          fallbackEntries.push({
            type: 'first_frame',
            url: curShot.firstFrameUrl,
            prompt: curShot.image_prompt || curShot.start_prompt || curShot.content,
          })
        }
        if ((!assetTypeRaw || assetTypeRaw === 'last_frame') && curShot.lastFrameUrl) {
          fallbackEntries.push({
            type: 'last_frame',
            url: curShot.lastFrameUrl,
            prompt: curShot.end_prompt,
          })
        }
        if ((!assetTypeRaw || assetTypeRaw === 'video') && curShot.finalVideoUrl) {
          fallbackEntries.push({
            type: 'video',
            url: curShot.finalVideoUrl,
            prompt: curShot.videoPrompt || curShot.motion_prompt,
          })
        }
        fallbackEntries.forEach((entry, idx) => {
          formatted.push({
            id: -(idx + 1),
            work_id: effectiveWorkId,
            chapter_id: chId,
            scene_index: pos.sceneIndex,
            shot_index: pos.shotIndex,
            asset_type: entry.type,
            version: 1,
            is_current: 1,
            url: entry.url,
            prompt: entry.prompt || null,
            model: null,
            model_key: null,
            gen_mode: curShot.gen_mode || null,
            params: null,
            duration: curShot.durShort || null,
            status: 'completed',
            raw_status: 'done',
            cost: 0,
            error_msg: null,
            created_at: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          })
        })
      }
    }

    return success(res, {
      panelIdx: pos.panelIdx,
      sceneIndex: pos.sceneIndex,
      shotIndex: pos.shotIndex,
      versions: formatted,
    })
  } catch (e: any) {
    return error(res, e?.message || '查询历史版本失败')
  }
})

/**
 * POST /pipeline/node/select
 * 切换某镜头某类资产的当前生效版本（is_current=1），并回写 chapters.content_configs
 */
router.post('/node/select', async (req, res) => {
  try {
    const {
      workId,
      chapterId,
      panelIdx,
      sceneIndex,
      shotIndex,
      assetType,
      version,
      assetId,
    } = req.body || {}

    const chId = Number(chapterId)
    if (!Number.isSafeInteger(chId) || chId <= 0) {
      return error(res, 'chapterId 必须为正整数', 400)
    }
    if (!VALID_ASSET_TYPES.has(assetType)) {
      return error(res, `无效的资产类型: ${String(assetType)}`, 400)
    }
    if (version == null && assetId == null) {
      return error(res, '请提供要切换的 version 或 assetId', 400)
    }

    const wId = workId ? Number(workId) : 0
    const { row: chapterRow, configs } = await loadChapterRow(chId, wId || undefined)
    const pos = resolveShotPosition(configs, { panelIdx, sceneIndex, shotIndex })

    const result = await selectShotAssetVersion({
      chapterId: chId,
      sceneIndex: pos.sceneIndex,
      shotIndex: pos.shotIndex,
      assetType,
      version: version != null ? Number(version) : undefined,
      assetId: assetId != null ? Number(assetId) : undefined,
    })

    const { row: refreshedRow, configs: refreshedConfigs } = await loadChapterRow(chId, wId || undefined)
    const updatedShot = refreshedConfigs[pos.sceneIndex]?.shots?.[pos.shotIndex] || null

    return success(res, {
      panelIdx: pos.panelIdx,
      sceneIndex: pos.sceneIndex,
      shotIndex: pos.shotIndex,
      selected: formatVersionForClient(result.selected, wId || Number(refreshedRow?.work_id || chapterRow?.work_id || 0)),
      videoNeedsRerun: result.videoNeedsRerun,
      shot: updatedShot,
    })
  } catch (e: any) {
    return error(res, e?.message || '切换版本失败')
  }
})

/**
 * POST /pipeline/video/upscale
 * 视频超分节点（兼容 `sourceUrl` 与 `videoUrl`、`panelIdx` 与 `sceneIndex + shotIndex`），写入 shot_assets 新版本并同步章节成片字段
 */
router.post('/video/upscale', async (req, res) => {
  try {
    const {
      workId,
      videoUrl,
      sourceUrl,
      targetResolution = '1080p',
      aspectRatio,
      chapterId,
      panelIdx,
      sceneIndex,
      shotIndex,
      assetType = 'video',
    } = req.body || {}

    const chId = chapterId != null ? Number(chapterId) : undefined
    const wId = workId != null ? Number(workId) : undefined
    const { row: chapterRow, configs } = chId ? await loadChapterRow(chId, wId) : { row: null, configs: [] as any[] }
    const pos = resolveShotPosition(configs, { panelIdx, sceneIndex, shotIndex })
    const curShot = configs[pos.sceneIndex]?.shots?.[pos.shotIndex]

    const effectiveVideoUrl = String(
      videoUrl || sourceUrl || curShot?.finalVideoUrl || curShot?.videoUrl || '',
    ).trim()
    if (!effectiveVideoUrl) {
      return error(res, '请提供待超分的视频地址（sourceUrl / videoUrl）', 400)
    }

    let effectiveRatio = aspectRatio
    if (!effectiveRatio && (wId || chapterRow?.work_id)) {
      try {
        const [workRow] = await db
          .select({ aspectRatio: schema.works.aspect_ratio })
          .from(schema.works)
          .where(eq(schema.works.id, Number(wId || chapterRow?.work_id)))
          .limit(1)
        if (workRow?.aspectRatio) effectiveRatio = workRow.aspectRatio
      } catch {
        // default to 16:9
      }
    }

    const result = await upscaleVideo({
      videoUrl: effectiveVideoUrl,
      targetResolution,
      aspectRatio: effectiveRatio || '16:9',
      chapterId: chId,
      sceneIndex: pos.sceneIndex,
      shotIndex: pos.shotIndex,
      assetType: assetType === 'compose' ? 'compose' : 'video',
    })

    // 若关联到具体分镜视频，同步回写 chapters.content_configs 中的 finalVideoUrl
    if (chId && chapterRow && assetType !== 'compose' && configs.length > 0) {
      try {
        const applied = applyAssetVersionToConfigs(configs, pos.sceneIndex, pos.shotIndex, {
          asset_type: 'video',
          url: result.url,
          version: result.version || 1,
        })
        await db
          .update(schema.chapters)
          .set({ content_configs: applied.configs, updatedAt: new Date() } as any)
          .where(eq(schema.chapters.id, chId))
      } catch (syncErr) {
        console.warn('[pipeline/video/upscale] 同步章节视频字段跳过:', syncErr)
      }
    }

    return success(res, result)
  } catch (e: any) {
    return error(res, e?.message || '视频超分失败')
  }
})

/**
 * POST /pipeline/prompts/infer
 * AnimaHub `{ prev, curr, next }` 滑动窗口上下文提示词推理 & 尾帧提示词推理接口
 */
router.post('/prompts/infer', async (req, res) => {
  try {
    const {
      workId,
      chapterId,
      panelIdx,
      sceneIndex,
      shotIndex,
      mode = 'contextual',
      save = true,
    } = req.body || {}

    const chId = Number(chapterId)
    if (!Number.isSafeInteger(chId) || chId <= 0) {
      return error(res, 'chapterId 必须为正整数', 400)
    }
    const inferMode: 'contextual' | 'end_frame' = mode === 'end_frame' ? 'end_frame' : 'contextual'

    const wId = workId ? Number(workId) : undefined
    const userId = Number((req as any).user?.id || 0) || undefined
    const { row: chapterRow, configs } = await loadChapterRow(chId, wId)
    if (!chapterRow || !configs.length) {
      return error(res, '章节或分镜数据不存在', 404)
    }

    const pos = resolveShotPosition(configs, { panelIdx, sceneIndex, shotIndex })
    const sceneObj = configs[pos.sceneIndex]
    const currShot = sceneObj?.shots?.[pos.shotIndex]
    if (!currShot) {
      return error(res, `未找到目标分镜 (panelIdx=${pos.panelIdx})`, 404)
    }

    const prevPos = pos.panelIdx > 0 ? resolveShotPosition(configs, { panelIdx: pos.panelIdx - 1 }) : null
    const nextPos = resolveShotPosition(configs, { panelIdx: pos.panelIdx + 1 })
    const prevShot = prevPos ? configs[prevPos.sceneIndex]?.shots?.[prevPos.shotIndex] || null : null
    const nextShot =
      nextPos.sceneIndex < configs.length && nextPos.shotIndex < (configs[nextPos.sceneIndex]?.shots?.length || 0)
        ? configs[nextPos.sceneIndex]?.shots?.[nextPos.shotIndex] || null
        : null

    const effectiveWorkId = wId || Number(chapterRow.work_id || 0)
    const effectiveUserId = userId || Number(chapterRow.user_id || 0)
    const styleProfile = effectiveWorkId && effectiveUserId
      ? await loadWorkStyleProfile({ workId: effectiveWorkId, userId: effectiveUserId })
      : { prompt: DEFAULT_STYLE_PROMPT, referenceUrl: '' }
    const evidence = effectiveWorkId && effectiveUserId
      ? await loadStoryboardEvidence({ workId: effectiveWorkId, chapterId: chId, userId: effectiveUserId }, [sceneObj])
      : { assets: [] }

    let inferred: InferredShotPrompts | null = null
    let source: 'agent' | 'deterministic' = 'deterministic'

    const aiModelHeader = String(req.headers['aimodel'] || req.body?.model || '').trim()
    const inferAgent = aiModelHeader
      ? await (async () => {
          try {
            const { mastra } = await import('../mastra')
            return mastra.getAgent('ShotPromptInferenceAgent')
          } catch {
            return null
          }
        })()
      : null

    if (inferAgent) {
      try {
        const requestContext = new RequestContext()
        if (aiModelHeader) {
          requestContext.set('modelId' as never, aiModelHeader as never)
        }
        inferred = await retryWithValidation(
          async (_attempt, lastError) => {
            const payload = buildContextualInferencePromptPayload({
              mode: inferMode,
              prevShot,
              currShot,
              nextShot,
              sceneEnvironment: String(sceneObj.environment || ''),
              stylePrompt: styleProfile.prompt,
              assets: (evidence.assets || []) as any[],
              feedback: lastError || undefined,
            })
            const resp = await inferAgent.generate(payload, { requestContext })
            return String(resp?.text || '')
          },
          raw => parseContextualInferenceResult(raw, inferMode, currShot, styleProfile.prompt),
          { maxAttempts: 2, baseDelayMs: 300 },
        )
        source = 'agent'
      } catch (agentErr: any) {
        console.warn(`[pipeline/prompts/infer] LLM 推理回退确定性推导: ${agentErr?.message || agentErr}`)
      }
    }

    if (!inferred) {
      const cleanStart = stripLeadingStylePrefix(
        String(currShot.image_prompt || currShot.start_prompt || currShot.content || '').trim(),
        styleProfile.prompt,
      )
      const motion = synthesizeMotionPromptDeterministic(currShot, prevShot)
      const end = inferEndFramePromptDeterministic({
        startPrompt: cleanStart,
        motionPrompt: motion,
        motionOut: currShot.motion?.out,
        cameraMovement: currShot.camera_movement,
        shotSize: currShot.shot_size,
        cameraAngle: currShot.camera_angle,
        characterAction: currShot.character_action || currShot.subject_motion,
        keyPropAction: currShot.key_prop_action,
        lighting: currShot.lighting,
        nextShotHint: nextShot?.link?.anchor,
      })
      inferred = {
        image_prompt: cleanStart,
        start_prompt: cleanStart,
        end_prompt: end,
        motion_prompt: motion,
        videoPrompt: motion,
      }
      source = 'deterministic'
    }

    if (save !== false) {
      const rawConfigs = typeof chapterRow.content_configs === 'string'
        ? JSON.parse(chapterRow.content_configs)
        : (Array.isArray(chapterRow.content_configs) ? structuredClone(chapterRow.content_configs) : [])
      const targetShot = rawConfigs[pos.sceneIndex]?.shots?.[pos.shotIndex]
      if (targetShot) {
        if (inferMode === 'end_frame') {
          targetShot.end_prompt = inferred.end_prompt
        } else {
          targetShot.image_prompt = inferred.image_prompt
          targetShot.start_prompt = inferred.start_prompt
          targetShot.end_prompt = inferred.end_prompt
          targetShot.motion_prompt = inferred.motion_prompt
          targetShot.videoPrompt = inferred.videoPrompt
          if (inferred.lighting) targetShot.lighting = inferred.lighting
          if (inferred.emotion) targetShot.emotion = inferred.emotion
        }
        await db
          .update(schema.chapters)
          .set({ content_configs: rawConfigs, updatedAt: new Date() } as any)
          .where(eq(schema.chapters.id, chId))
      }
    }

    return success(res, {
      panelIdx: pos.panelIdx,
      sceneIndex: pos.sceneIndex,
      shotIndex: pos.shotIndex,
      mode: inferMode,
      source,
      prompts: inferred,
      shot: {
        ...currShot,
        ...(inferMode === 'end_frame'
          ? { end_prompt: inferred.end_prompt }
          : {
              image_prompt: inferred.image_prompt,
              start_prompt: inferred.start_prompt,
              end_prompt: inferred.end_prompt,
              motion_prompt: inferred.motion_prompt,
              videoPrompt: inferred.videoPrompt,
              ...(inferred.lighting ? { lighting: inferred.lighting } : {}),
              ...(inferred.emotion ? { emotion: inferred.emotion } : {}),
            }),
      },
    })
  } catch (e: any) {
    return error(res, e?.message || '提示词推理失败')
  }
})

/**
 * GET /pipeline/models/capabilities
 * 查询指定模型（或全部启用视频模型）的能力 Schema（顶层直接返回 modes / params / inputLimits 兼容前端契约）
 */
router.get('/models/capabilities', async (req, res) => {
  try {
    const modelParam = req.query.model ? String(req.query.model).trim() : ''
    if (modelParam) {
      let dbRow: any = null
      try {
        const [row] = await db
          .select()
          .from(schema.ai_models)
          .where(eq(schema.ai_models.model, modelParam))
          .limit(1)
        dbRow = row
      } catch {
        // fallback to preset capability
      }
      const cap = resolveCapability(
        dbRow
          ? { key: dbRow.model, name: dbRow.name, capabilities: dbRow.capabilities }
          : modelParam,
      )
      return success(res, {
        model: modelParam,
        modes: cap.modes,
        params: cap.params,
        inputLimits: cap.inputLimits,
        capabilities: cap,
        modeLabels: VIDEO_MODE_LABELS,
        allModes: ALL_VIDEO_MODES,
      })
    }

    const defaultCap = resolveCapability(null)
    return success(res, {
      modes: defaultCap.modes,
      params: defaultCap.params,
      inputLimits: defaultCap.inputLimits,
      defaultCapabilities: defaultCap,
      modeLabels: VIDEO_MODE_LABELS,
      allModes: ALL_VIDEO_MODES,
    })
  } catch (e: any) {
    return error(res, e?.message || '获取模型能力配置失败')
  }
})

export default router
