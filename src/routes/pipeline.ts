import express from 'express'
import { eq } from 'drizzle-orm'
import { db, schema } from '../mysqlDb'
import { success, error } from '../tools/response'
import { runNode, runSubgraph } from '../pipeline/scheduler'
import { listShotAssetVersions, selectShotAssetVersion, type ShotAssetType } from '../pipeline/shot-assets-store'
import { resolveCapability, VIDEO_MODE_LABELS, ALL_VIDEO_MODES } from '../pipeline/model-schema'
import { upscaleVideo } from '../videoTools/upscale'
import type { PipelineNodeType } from '../pipeline/registry'

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

/**
 * POST /pipeline/node/run
 * 单节点独立执行（重跑某镜头的图片、视频、配音、合成或超分节点，不触碰其他镜头）
 */
router.post('/node/run', async (req, res) => {
  try {
    const {
      chapterId,
      sceneIndex = 0,
      shotIndex = 0,
      nodeType,
      assetType,
      modelKey,
      mode,
      params,
    } = req.body || {}

    const chId = Number(chapterId)
    const scIdx = Number(sceneIndex)
    const shIdx = Number(shotIndex)
    if (!Number.isSafeInteger(chId) || chId <= 0) {
      return error(res, 'chapterId 必须为正整数', 400)
    }
    if (!Number.isSafeInteger(scIdx) || scIdx < 0 || !Number.isSafeInteger(shIdx) || shIdx < 0) {
      return error(res, 'sceneIndex 与 shotIndex 必须为非负整数', 400)
    }
    if (!VALID_NODE_TYPES.has(nodeType)) {
      return error(res, `不支持的节点类型: ${String(nodeType)}`, 400)
    }

    const result = await runNode({
      chapterId: chId,
      sceneIndex: scIdx,
      shotIndex: shIdx,
      nodeType,
      assetType,
      modelKey,
      mode,
      params,
    })
    return success(res, result)
  } catch (e: any) {
    return error(res, e?.message || '节点执行失败')
  }
})

/**
 * POST /pipeline/batch/run
 * 批量子图调度（勾选多个镜头批量生成图片 / 视频 / 配音）
 */
router.post('/batch/run', async (req, res) => {
  try {
    const {
      chapterId,
      nodeType,
      targets,
      modelKey,
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
    if (!Array.isArray(targets) || targets.length === 0) {
      return error(res, '请至少勾选 1 个目标镜头（targets）', 400)
    }

    const normalizedTargets = targets.map((t: any) => ({
      sceneIndex: Number(t?.sceneIndex ?? 0),
      shotIndex: Number(t?.shotIndex ?? 0),
      mode: t?.mode,
      params: t?.params,
    }))

    const result = await runSubgraph({
      chapterId: chId,
      nodeType,
      targets: normalizedTargets,
      modelKey,
      assetType,
      concurrency: concurrency ? Number(concurrency) : 2,
    })
    return success(res, result)
  } catch (e: any) {
    return error(res, e?.message || '批量执行失败')
  }
})

/**
 * GET /pipeline/node/versions
 * 查询某镜头（可选按 assetType 过滤）的全部历史版本列表
 */
router.get('/node/versions', async (req, res) => {
  try {
    const chId = Number(req.query.chapterId)
    const scIdx = Number(req.query.sceneIndex ?? 0)
    const shIdx = Number(req.query.shotIndex ?? 0)
    const assetTypeRaw = req.query.assetType ? String(req.query.assetType).trim() : undefined

    if (!Number.isSafeInteger(chId) || chId <= 0) {
      return error(res, 'chapterId 必须为正整数', 400)
    }
    if (assetTypeRaw && !VALID_ASSET_TYPES.has(assetTypeRaw as ShotAssetType)) {
      return error(res, `不支持的资产类型: ${assetTypeRaw}`, 400)
    }

    const versions = await listShotAssetVersions({
      chapterId: chId,
      sceneIndex: Number.isSafeInteger(scIdx) && scIdx >= 0 ? scIdx : 0,
      shotIndex: Number.isSafeInteger(shIdx) && shIdx >= 0 ? shIdx : 0,
      assetType: assetTypeRaw as ShotAssetType | undefined,
    })
    return success(res, versions)
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
      chapterId,
      sceneIndex = 0,
      shotIndex = 0,
      assetType,
      version,
      assetId,
    } = req.body || {}

    const chId = Number(chapterId)
    const scIdx = Number(sceneIndex)
    const shIdx = Number(shotIndex)
    if (!Number.isSafeInteger(chId) || chId <= 0) {
      return error(res, 'chapterId 必须为正整数', 400)
    }
    if (!VALID_ASSET_TYPES.has(assetType)) {
      return error(res, `无效的资产类型: ${String(assetType)}`, 400)
    }
    if (version == null && assetId == null) {
      return error(res, '请提供要切换的 version 或 assetId', 400)
    }

    const result = await selectShotAssetVersion({
      chapterId: chId,
      sceneIndex: scIdx,
      shotIndex: shIdx,
      assetType,
      version: version != null ? Number(version) : undefined,
      assetId: assetId != null ? Number(assetId) : undefined,
    })
    return success(res, result)
  } catch (e: any) {
    return error(res, e?.message || '切换版本失败')
  }
})

/**
 * POST /pipeline/video/upscale
 * 视频超分节点（Lanczos + Unsharp 1080P / 2K / 4K），写入 shot_assets 新版本
 */
router.post('/video/upscale', async (req, res) => {
  try {
    const {
      videoUrl,
      targetResolution = '1080p',
      aspectRatio = '16:9',
      chapterId,
      sceneIndex = 0,
      shotIndex = 0,
      assetType = 'video',
    } = req.body || {}

    if (!videoUrl || typeof videoUrl !== 'string') {
      return error(res, '请提供待超分的视频地址（videoUrl）', 400)
    }

    const result = await upscaleVideo({
      videoUrl,
      targetResolution,
      aspectRatio,
      chapterId: chapterId != null ? Number(chapterId) : undefined,
      sceneIndex: Number(sceneIndex),
      shotIndex: Number(shotIndex),
      assetType: assetType === 'compose' ? 'compose' : 'video',
    })
    return success(res, result)
  } catch (e: any) {
    return error(res, e?.message || '视频超分失败')
  }
})

/**
 * GET /pipeline/models/capabilities
 * 查询指定模型（或全部启用视频模型）的能力 Schema（modes / params / inputLimits）
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
        capabilities: cap,
        modeLabels: VIDEO_MODE_LABELS,
        allModes: ALL_VIDEO_MODES,
      })
    }

    return success(res, {
      defaultCapabilities: resolveCapability(null),
      modeLabels: VIDEO_MODE_LABELS,
      allModes: ALL_VIDEO_MODES,
    })
  } catch (e: any) {
    return error(res, e?.message || '获取模型能力配置失败')
  }
})

export default router
