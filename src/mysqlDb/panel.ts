import { eq } from 'drizzle-orm'
import { db, schema } from './index'
import { resolveStoryboardPanel } from '../tools/storyboard-panel'
import { assignPanelFrame } from '../tools/frame-pool'
import { normalizeShotLink } from '../tools/storyboard-text'

/** 行锁保护分镜配置；必须等待修改回调及事务提交后才返回。 */
export async function modifyPanelInTx(
  chapterId: number,
  panelIdx: number,
  modifier: (panel: any, configs: any[], target: { scene: any; shot: any; sceneIdx: number | undefined }) => Promise<any>,
) {
  return db.transaction(async tx => {
    const rows = await tx.select({ configs: schema.chapters.content_configs })
      .from(schema.chapters).where(eq(schema.chapters.id, chapterId)).for('update')
    const configs = (rows[0]?.configs as any[]) || []
    const target = resolveStoryboardPanel(configs, panelIdx)
    if (!target) throw new Error('分镜不存在')
    const { panel } = target
    await modifier(panel, configs, target)
    target.commit()
    await tx.update(schema.chapters).set({ content_configs: configs })
      .where(eq(schema.chapters.id, chapterId))
    return panel
  })
}

export type PanelFrameGenerationPlan = {
  inheritsPreviousFrame: boolean
  inheritedFirstFrameUrl: string
}

/** 同场景且衔接类型为 continuous 的后续分镜继承上一分镜尾帧；cut / transition 或切换场景时重新生成首尾帧。 */
export async function preparePanelFrameGeneration(chapterId: number, panelIdx: number) {
  return db.transaction(async tx => {
    const rows = await tx.select({ configs: schema.chapters.content_configs })
      .from(schema.chapters).where(eq(schema.chapters.id, chapterId)).for('update')
    const configs = (rows[0]?.configs as any[]) || []
    const target = resolveStoryboardPanel(configs, panelIdx)
    if (!target) throw new Error('分镜不存在')
    const { panel } = target

    const previousTarget = panelIdx > 0 ? resolveStoryboardPanel(configs, panelIdx - 1) : undefined
    const previous = previousTarget?.panel
    const isContinuous = normalizeShotLink(panel).type === 'continuous'
    const inheritsPreviousFrame = Boolean(
      isContinuous
      && previous
      && (target.sceneIdx === undefined || target.sceneIdx === previousTarget?.sceneIdx)
      && panel.scene_id != null
      && previous.scene_id != null
      && String(panel.scene_id) === String(previous.scene_id),
    )

    let inheritedFirstFrameUrl = ''
    if (inheritsPreviousFrame) {
      if (!previous?.lastFrameUrl) throw new Error('上一分镜尚未生成尾帧，请先生成上一分镜')
      inheritedFirstFrameUrl = previous.lastFrameUrl
      // 帧链：本镜首帧就是上一镜尾帧（同一张画面，池里只存一份），共享同一个 frameId
      if (target.sceneIdx === undefined) panel.firstFrameUrl = inheritedFirstFrameUrl // 旧扁平结构：内联字段兜底
      else assignPanelFrame(target.scene, panel, 'start', { url: inheritedFirstFrameUrl })
    } else if (target.sceneIdx === undefined) {
      panel.firstFrameUrl = ''
    } else {
      assignPanelFrame(target.scene, panel, 'start', null)
    }
    panel.panelStatus = 'generating'
    target.commit()

    await tx.update(schema.chapters).set({ content_configs: configs })
      .where(eq(schema.chapters.id, chapterId))
    return {
      plan: { inheritsPreviousFrame, inheritedFirstFrameUrl } satisfies PanelFrameGenerationPlan,
      panel,
    }
  })
}

type AssetReference = {
  id: number
  type: string
  imageId: string | null
  image: string
}

/** 保存最近几次实际使用的素材版本，旧的完整快照会同步压缩。 */
export async function appendPanelAssetReferenceHistory(
  chapterId: number,
  panelIdx: number,
  references: AssetReference[],
  maxEntries = 10,
) {
  await modifyPanelInTx(chapterId, panelIdx, async panel => {
    const history = (Array.isArray(panel.assetReferenceHistory)
      ? panel.assetReferenceHistory
      : []).slice(-(maxEntries - 1)).map((entry: any) => ({
        createdAt: entry?.createdAt || '',
        assets: (Array.isArray(entry?.assets) ? entry.assets : []).map((asset: any) => ({
          id: asset?.id,
          type: asset?.type,
          imageId: asset?.imageId || null,
          image: asset?.image || '',
        })),
      }))
    panel.assetReferenceHistory = [...history, {
      createdAt: new Date().toISOString(),
      assets: references.map(({ id, type, imageId, image }) => ({ id, type, imageId, image })),
    }]
  })
}
