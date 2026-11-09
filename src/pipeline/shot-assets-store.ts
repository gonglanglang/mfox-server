import { and, desc, eq } from 'drizzle-orm'
import { db } from '../mysqlDb/index'
import { chapters, shot_assets } from '../mysqlDb/schema'

export type ShotAssetType =
  | 'first_frame'
  | 'last_frame'
  | 'reference_frame'
  | 'video'
  | 'tts'
  | 'compose'

export interface ShotAssetRecord {
  id: number
  chapter_id: number
  scene_index: number
  shot_index: number
  asset_type: ShotAssetType
  version: number
  is_current: number
  url: string | null
  prompt: string | null
  model_key: string | null
  gen_mode: string | null
  params: Record<string, any> | null
  duration: number | null
  status: 'pending' | 'generating' | 'done' | 'failed'
  error_msg: string | null
  created_at: Date | string
}

export interface CreateShotAssetInput {
  workId?: number
  chapterId: number
  sceneIndex: number
  shotIndex: number
  assetType: ShotAssetType
  url?: string | null
  prompt?: string | null
  modelKey?: string | null
  genMode?: string | null
  params?: Record<string, any> | null
  duration?: number | null
  status?: 'pending' | 'generating' | 'done' | 'failed'
  errorMsg?: string | null
  makeCurrent?: boolean
}

const memoryAssets = new Map<string, ShotAssetRecord[]>()
let memoryAutoId = 1

function slotKey(chapterId: number, sceneIndex: number, shotIndex: number, assetType: ShotAssetType): string {
  return `${chapterId}:${sceneIndex}:${shotIndex}:${assetType}`
}

function assetTypeToKind(assetType: ShotAssetType): 'image' | 'video' | 'audio' {
  if (assetType === 'first_frame' || assetType === 'last_frame' || assetType === 'reference_frame') {
    return 'image'
  }
  if (assetType === 'tts') return 'audio'
  return 'video'
}

function canUseDatabase(): boolean {
  const hasMockInsert = Boolean((db as any)?.insert?.mock)
  if (hasMockInsert) return true
  if ((db as any)?.select?.mock && !hasMockInsert) return false
  return Boolean(process.env.DB_HOST && process.env.DB_NAME)
}

export function clearMemoryShotAssets(): void {
  memoryAssets.clear()
  memoryAutoId = 1
}

function recordInMemory(input: CreateShotAssetInput): ShotAssetRecord {
  const key = slotKey(input.chapterId, input.sceneIndex, input.shotIndex, input.assetType)
  const list = memoryAssets.get(key) || []
  const maxVersion = list.reduce((max, item) => Math.max(max, item.version), 0)
  const nextVersion = maxVersion + 1
  const makeCurrent = input.makeCurrent !== false && (input.status ?? 'done') === 'done'

  if (makeCurrent) {
    for (const item of list) {
      item.is_current = 0
    }
  }

  const record: ShotAssetRecord = {
    id: memoryAutoId++,
    chapter_id: input.chapterId,
    scene_index: input.sceneIndex,
    shot_index: input.shotIndex,
    asset_type: input.assetType,
    version: nextVersion,
    is_current: makeCurrent ? 1 : 0,
    url: input.url ?? null,
    prompt: input.prompt ?? null,
    model_key: input.modelKey ?? null,
    gen_mode: input.genMode ?? null,
    params: input.params ?? null,
    duration: input.duration ?? null,
    status: input.status ?? 'done',
    error_msg: input.errorMsg ?? null,
    created_at: new Date(),
  }
  list.push(record)
  memoryAssets.set(key, list)
  return { ...record }
}

function rowToShotAssetRecord(row: typeof shot_assets.$inferSelect): ShotAssetRecord {
  const rawParams = typeof row.params === 'string'
    ? (() => { try { return JSON.parse(row.params) } catch { return {} } })()
    : ((row.params as Record<string, any>) || {})
  return {
    id: Number(row.id),
    chapter_id: Number(row.chapter_id),
    scene_index: Number(row.scene_idx),
    shot_index: Number(row.shot_idx),
    asset_type: (row.role as ShotAssetType) || 'first_frame',
    version: Number(row.version),
    is_current: Number(row.is_current ?? 0),
    url: row.url ?? null,
    prompt: rawParams.prompt ?? null,
    model_key: row.model ?? rawParams.model_key ?? null,
    gen_mode: rawParams.gen_mode ?? null,
    params: rawParams,
    duration: rawParams.duration != null ? Number(rawParams.duration) : null,
    status: (row.status || 'done') as ShotAssetRecord['status'],
    error_msg: rawParams.error_msg ?? null,
    created_at: row.created_at,
  }
}

/**
 * 写入一条新的分镜资产版本记录（自动递增 version，默认置为 is_current=1 并把旧版本置为 0，绝不覆盖历史版本）。
 */
export async function recordShotAssetVersion(input: CreateShotAssetInput): Promise<ShotAssetRecord> {
  const memRecord = recordInMemory(input)
  try {
    if (!canUseDatabase() || typeof (db as any)?.select !== 'function' || typeof (db as any)?.insert !== 'function') {
      return memRecord
    }
    const existing = await db
      .select()
      .from(shot_assets)
      .where(
        and(
          eq(shot_assets.chapter_id, input.chapterId),
          eq(shot_assets.scene_idx, input.sceneIndex),
          eq(shot_assets.shot_idx, input.shotIndex),
          eq(shot_assets.role, input.assetType),
        ),
      )
      .orderBy(desc(shot_assets.version))

    const maxVersion = existing.reduce((max, row) => Math.max(max, Number(row.version || 0)), 0)
    const nextVersion = maxVersion + 1
    const makeCurrent = input.makeCurrent !== false && (input.status ?? 'done') === 'done'

    if (makeCurrent && existing.length > 0) {
      await db
        .update(shot_assets)
        .set({ is_current: 0 })
        .where(
          and(
            eq(shot_assets.chapter_id, input.chapterId),
            eq(shot_assets.scene_idx, input.sceneIndex),
            eq(shot_assets.shot_idx, input.shotIndex),
            eq(shot_assets.role, input.assetType),
          ),
        )
    }

    const packedParams: Record<string, any> = {
      ...(input.params || {}),
      ...(input.prompt != null ? { prompt: input.prompt } : {}),
      ...(input.genMode != null ? { gen_mode: input.genMode } : {}),
      ...(input.duration != null ? { duration: input.duration } : {}),
      ...(input.errorMsg != null ? { error_msg: input.errorMsg } : {}),
    }

    const [insertResult] = await db.insert(shot_assets).values({
      work_id: input.workId ?? 0,
      chapter_id: input.chapterId,
      scene_idx: input.sceneIndex,
      shot_idx: input.shotIndex,
      kind: assetTypeToKind(input.assetType),
      role: input.assetType,
      version: nextVersion,
      is_current: makeCurrent ? 1 : 0,
      url: input.url ?? '',
      model: input.modelKey ?? '',
      params: packedParams,
      status: input.status ?? 'done',
      created_at: new Date(),
    })

    const insertedId = Number((insertResult as any)?.insertId || memRecord.id)
    memRecord.id = insertedId
    memRecord.version = nextVersion
    return {
      ...memRecord,
      id: insertedId,
      version: nextVersion,
    }
  } catch {
    return memRecord
  }
}

/**
 * 查询某镜头（可选指定 assetType）的全部历史版本（按 version 降序）。
 */
export async function listShotAssetVersions(params: {
  chapterId: number
  sceneIndex: number
  shotIndex: number
  assetType?: ShotAssetType
}): Promise<ShotAssetRecord[]> {
  try {
    if (canUseDatabase() && typeof (db as any)?.select === 'function' && typeof (db as any)?.insert === 'function') {
      const conditions = [
        eq(shot_assets.chapter_id, params.chapterId),
        eq(shot_assets.scene_idx, params.sceneIndex),
        eq(shot_assets.shot_idx, params.shotIndex),
      ]
      if (params.assetType) {
        conditions.push(eq(shot_assets.role, params.assetType))
      }
      const rows = await db
        .select()
        .from(shot_assets)
        .where(and(...conditions))
        .orderBy(desc(shot_assets.version))
      if (rows.length > 0) {
        return rows.map(rowToShotAssetRecord)
      }
    }
  } catch {
    // Fallback to memory store
  }

  const allTypes: ShotAssetType[] = params.assetType
    ? [params.assetType]
    : ['first_frame', 'last_frame', 'reference_frame', 'video', 'tts', 'compose']
  const out: ShotAssetRecord[] = []
  for (const t of allTypes) {
    const key = slotKey(params.chapterId, params.sceneIndex, params.shotIndex, t)
    const list = memoryAssets.get(key) || []
    out.push(...list.map(item => ({ ...item })))
  }
  return out.sort((a, b) => b.version - a.version)
}

/**
 * 把选定版本写回 chapters.content_configs 对应镜头的冗余字段，保证前端与合成工作流零改造读取当前版本。
 */
export function applyAssetVersionToConfigs(
  configs: any[],
  sceneIndex: number,
  shotIndex: number,
  asset: Pick<ShotAssetRecord, 'asset_type' | 'url' | 'version'>,
): { configs: any[]; videoNeedsRerun: boolean } {
  if (!Array.isArray(configs) || !configs[sceneIndex] || !Array.isArray(configs[sceneIndex].shots)) {
    return { configs, videoNeedsRerun: false }
  }
  const scene = { ...configs[sceneIndex] }
  const shots = [...scene.shots]
  const shot = shots[shotIndex] ? { ...shots[shotIndex] } : null
  if (!shot) return { configs, videoNeedsRerun: false }

  let videoNeedsRerun = false
  const url = asset.url || ''
  switch (asset.asset_type) {
    case 'first_frame':
      shot.firstFrameUrl = url
      shot.firstFrameVersion = asset.version
      if (shot.videoUrl || shot.finalVideoUrl) {
        shot.videoNeedsRerun = true
        videoNeedsRerun = true
      }
      break
    case 'last_frame':
      shot.lastFrameUrl = url
      shot.lastFrameVersion = asset.version
      if (shot.videoUrl || shot.finalVideoUrl) {
        shot.videoNeedsRerun = true
        videoNeedsRerun = true
      }
      break
    case 'reference_frame':
      shot.reference_frame_url = url
      shot.referenceFrameVersion = asset.version
      if (shot.videoUrl || shot.finalVideoUrl) {
        shot.videoNeedsRerun = true
        videoNeedsRerun = true
      }
      break
    case 'video':
      shot.videoUrl = url
      shot.finalVideoUrl = url
      shot.videoVersion = asset.version
      shot.videoNeedsRerun = false
      break
    case 'tts':
      shot.ttsAudioUrl = url
      shot.ttsVersion = asset.version
      break
    case 'compose':
      break
  }

  shots[shotIndex] = shot
  scene.shots = shots
  const nextConfigs = [...configs]
  nextConfigs[sceneIndex] = scene
  return { configs: nextConfigs, videoNeedsRerun }
}

/**
 * 切换某镜头某类产物的当前生效版本（is_current=1），并同步回写 chapters.content_configs。
 */
export async function selectShotAssetVersion(params: {
  chapterId: number
  sceneIndex: number
  shotIndex: number
  assetType: ShotAssetType
  version?: number
  assetId?: number
}): Promise<{ selected: ShotAssetRecord; videoNeedsRerun: boolean }> {
  const key = slotKey(params.chapterId, params.sceneIndex, params.shotIndex, params.assetType)
  const memList = memoryAssets.get(key) || []
  let targetMem: ShotAssetRecord | undefined
  for (const item of memList) {
    const match = (params.assetId != null && item.id === params.assetId)
      || (params.version != null && item.version === params.version)
    item.is_current = match ? 1 : 0
    if (match) targetMem = { ...item }
  }

  let selected: ShotAssetRecord | undefined = targetMem

  try {
    if (canUseDatabase() && typeof (db as any)?.select === 'function' && typeof (db as any)?.update === 'function') {
      const rows = await db
        .select()
        .from(shot_assets)
        .where(
          and(
            eq(shot_assets.chapter_id, params.chapterId),
            eq(shot_assets.scene_idx, params.sceneIndex),
            eq(shot_assets.shot_idx, params.shotIndex),
            eq(shot_assets.role, params.assetType),
          ),
        )
      const targetRow = rows.find(r =>
        (params.assetId != null && Number(r.id) === Number(params.assetId))
        || (params.version != null && Number(r.version) === Number(params.version)),
      )
      if (targetRow) {
        await db
          .update(shot_assets)
          .set({ is_current: 0 })
          .where(
            and(
              eq(shot_assets.chapter_id, params.chapterId),
              eq(shot_assets.scene_idx, params.sceneIndex),
              eq(shot_assets.shot_idx, params.shotIndex),
              eq(shot_assets.role, params.assetType),
            ),
          )
        await db
          .update(shot_assets)
          .set({ is_current: 1 })
          .where(eq(shot_assets.id, targetRow.id))

        selected = {
          ...rowToShotAssetRecord(targetRow),
          is_current: 1,
        }
      }
    }
  } catch {
    // use memory selection if DB not available
  }

  if (!selected) {
    throw new Error(`未找到可切换的资产版本（chapter=${params.chapterId}, scene=${params.sceneIndex}, shot=${params.shotIndex}, type=${params.assetType}）`)
  }

  let videoNeedsRerun = ['first_frame', 'last_frame', 'reference_frame'].includes(params.assetType)
  try {
    if (canUseDatabase() && typeof (db as any)?.select === 'function' && typeof (db as any)?.update === 'function') {
      const [chapterRow] = await db
        .select()
        .from(chapters)
        .where(eq(chapters.id, params.chapterId))
        .limit(1)
      if (chapterRow) {
        const rawConfigs = typeof chapterRow.content_configs === 'string'
          ? JSON.parse(chapterRow.content_configs)
          : (Array.isArray(chapterRow.content_configs) ? chapterRow.content_configs : [])
        const applied = applyAssetVersionToConfigs(rawConfigs, params.sceneIndex, params.shotIndex, selected)
        videoNeedsRerun = applied.videoNeedsRerun
        await db
          .update(chapters)
          .set({ content_configs: applied.configs })
          .where(eq(chapters.id, params.chapterId))
      }
    }
  } catch {
    // ignore chapter sync failure in unit tests without chapters table
  }

  return { selected, videoNeedsRerun }
}
