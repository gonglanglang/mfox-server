import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../mysqlDb'
import { modifyPanelInTx } from '../../mysqlDb/panel'
import { resolveStoryboardPanel } from '../../tools/storyboard-panel'
import { loadStoryboardEvidence } from '../../tools/storyboard-evidence'
import { buildCharacterCard, buildSceneCard, buildPropCard, DEFAULT_STYLE_PROMPT } from '../../tools/storyboard-assets'
import { frameContinuityPlan, framePlanSchema, framePlanSnapshot } from '../../tools/frame-continuity'
import { assetFrameReferences, numberFrameReferences, assertFramePromptPair } from '../../tools/frame-prompts'
import { REDRAW_FRAME_COUNT, type FrameRedrawMode } from '../../tools/frame-redraw-job'
import { generateFrame as generateFrameImage } from '../../tools/frame-gen'
import { assignPanelFrame, shotFrameRef, shotFrameUrl } from '../../tools/frame-pool'
import { imageDryRunEnabled } from '../../imageTools/dry-run'
import { normalizeShotLink } from '../../tools/storyboard-text'
import { sanitizeShotNegativePrompt } from './NovelScriptFlows/index'
import { recordShotAssetVersion } from '../../pipeline/shot-assets-store'
export { numberFrameReferences } from '../../tools/frame-prompts'

// ============================================
// 分镜重绘工作流：支持市场主流单关键帧模式（single）与首尾双帧模式（dual）
// - single（主流单帧 I2V 模式，默认推荐）：每镜只生成 1 张主关键帧（firstFrameUrl），省 50% 积分与时间，
//   由视频大模型根据首帧 + 三段式动作演进自然驱动运动，彻底消除“首尾两张 AI 图对不齐”导致的画面扭曲与动作还原重做。
// - dual（传统首尾双帧模式）：生成首帧 + 尾帧两张图；同场景 continuous 镜头首帧复用上一镜尾帧。
// ============================================

const inputSchema = z.object({
  chapterId: z.number().int().positive(), userId: z.number().int().positive(), workId: z.number().int().positive(),
  panelIdx: z.number().int().nonnegative(), runId: z.string().min(1), styleId: z.number().int().positive(),
  model: z.string().trim().min(1),
  resolution: z.string().trim().min(1), quality: z.string().optional(),
})
const preparedSchema = inputSchema.extend({
  frameMode: z.enum(['single', 'dual', 'video_tail']).default('dual'),
  plan: framePlanSchema, snapshot: z.string(),
  assetReferences: z.array(z.object({ label: z.string(), url: z.string() })),
  // ── 全局风格锚 + 设定卡（StyleProfile / 角色卡 / 场景卡 / 道具卡）──
  styleProfile: z.object({ prompt: z.string(), referenceUrl: z.string() }),
  characterCards: z.array(z.object({ id: z.union([z.number(), z.string()]), text: z.string(), imageUrl: z.string() })),
  sceneCard: z.object({ id: z.union([z.number(), z.string()]), text: z.string(), imageUrl: z.string() }).nullable(),
  propCards: z.array(z.object({ id: z.union([z.number(), z.string()]), text: z.string(), imageUrl: z.string() })),
  characterReferences: z.array(z.object({ role_id: z.number(), asset_url: z.string(), description: z.string() })),
  sceneSnapshot: z.object({ scene_id: z.number().nullable(), text: z.string(), image_url: z.string() }).nullable(),
})
const startSchema = preparedSchema.extend({
  firstFrameUrl: z.string().min(1),
  /** 首帧的复现种子；继承上一镜尾帧时为 null（池中该帧条目已记录） */
  firstFrameSeed: z.number().int().nullable(),
  inheritedFirstFrame: z.boolean(),
})
const endSchema = startSchema.extend({
  lastFrameUrl: z.string(),
  lastFrameSeed: z.number().int().nullable(),
})
const outputSchema = z.object({ firstFrameUrl: z.string().min(1), lastFrameUrl: z.string() })
type Prepared = z.infer<typeof preparedSchema>

const prepareReferences = createStep({
  id: 'prepare-frame-references', inputSchema, outputSchema: preparedSchema,
  execute: async ({ inputData }) => {
    const [chapter] = await db.select().from(schema.chapters).where(and(
      eq(schema.chapters.id, inputData.chapterId), eq(schema.chapters.work_id, inputData.workId), eq(schema.chapters.user_id, inputData.userId),
    ))
    if (!chapter) throw new Error('章节不存在')
    const configs = (chapter.content_configs as any[]) || []
    const panel = resolveStoryboardPanel(configs, inputData.panelIdx)?.panel
    if (panel?.redrawRun?.id !== inputData.runId || panel.redrawRun.status !== 'charged') throw new Error('重绘任务已失效')
    const frameMode: FrameRedrawMode = panel.redrawRun?.frameMode || panel.frame_mode || 'dual'
    const plan = frameContinuityPlan(configs, inputData.panelIdx, { frameMode })
    const snapshot = framePlanSnapshot(plan)
    if (snapshot !== panel.redrawRun.snapshot) throw new Error('分镜或相邻镜头已变化，请重新提交')
    if (frameMode === 'single') {
      if (!plan.current.start_prompt.trim()) throw new Error('请先填写首帧提示词')
      assertFramePromptPair(plan.current.start_prompt, String(plan.current.end_prompt || ''))
    } else {
      if (!plan.current.start_prompt.trim() || !plan.current.end_prompt.trim()) throw new Error('请先填写首帧和尾帧提示词')
      assertFramePromptPair(plan.current.start_prompt, plan.current.end_prompt)
    }
    const shots = [plan.current, ...(plan.previous ? [plan.previous] : []), ...(plan.next?.firstFrameUrl ? [plan.next] : [])]
    const evidence = await loadStoryboardEvidence(inputData, [{ scene_id: plan.scene_id, prop_ids: plan.prop_ids, shots }])
    const assets = evidence.assets || []
    const required = [['scene', plan.scene_id] as const, ...plan.prop_ids.map(id => ['prop', id] as const),
      ...shots.flatMap(shot => shot.roles.map(role => ['persona', role.id] as const))]
    for (const [type, id] of required) {
      if (!assets.some(asset => asset.type === type && Number(asset.id) === id && asset.image))
        throw new Error(`缺少素材参考图：${type} ${id}，请先选择可用图片`)
    }
    const [style] = await db.select({
      description: schema.visualStyles.description,
      effectImage: schema.visualStyles.effect_image,
    }).from(schema.visualStyles).where(eq(schema.visualStyles.style_id, inputData.styleId))
    // ── 全局风格锚（作品画风：description + effect_image）+ 角色/场景/道具设定卡 ──
    const styleProfile = {
      prompt: String(style?.description || '').trim() || DEFAULT_STYLE_PROMPT,
      referenceUrl: String(style?.effectImage || '').trim(),
    }
    const current = plan.current
    const cardFor = (type: string, id: unknown) => assets.find(asset => asset.type === type && String(asset.id) === String(id))
    const characterCards = current.roles
      .map(role => buildCharacterCard(cardFor('persona', role.id)))
      .filter((card): card is NonNullable<typeof card> => card !== null)
    const sceneAsset = cardFor('scene', plan.scene_id)
    const sceneCard = sceneAsset ? buildSceneCard(sceneAsset) : null
    const propCards = plan.prop_ids
      .map(id => buildPropCard(cardFor('prop', id)))
      .filter((card): card is NonNullable<typeof card> => card !== null)
    const characterReferences = characterCards.map(card => ({
      role_id: Number(card.id), asset_url: card.imageUrl, description: card.text,
    }))
    if (Array.isArray(panel?.character_refs)) {
      const existingRoleIds = new Set(characterReferences.map(r => String(r.role_id)))
      for (const ref of panel.character_refs) {
        const roleIdNum = Number(ref?.role_id)
        const roleKey = String(ref?.role_id ?? '').trim()
        if (!roleKey || existingRoleIds.has(roleKey)) continue
        const imgUrl = String(ref?.image_url || '').trim()
        const desc = String(ref?.description || ref?.name || '').trim()
        if (imgUrl || desc) {
          existingRoleIds.add(roleKey)
          characterReferences.push({
            role_id: Number.isFinite(roleIdNum) && roleIdNum > 0 ? roleIdNum : 0,
            asset_url: imgUrl,
            description: desc || `Character ${ref?.name || roleKey}`,
          })
          characterCards.push({
            id: Number.isFinite(roleIdNum) && roleIdNum > 0 ? roleIdNum : 0,
            name: String(ref?.name || roleKey),
            text: desc || `Character ${ref?.name || roleKey}`,
            imageUrl: imgUrl,
          })
        }
      }
    }
    const sceneSnapshot = sceneCard ? {
      scene_id: Number(sceneCard.id) || null, text: sceneCard.text, image_url: sceneCard.imageUrl,
    } : null
    return {
      ...inputData, frameMode, plan, snapshot,
      assetReferences: assetFrameReferences(assets),
      styleProfile, characterCards, sceneCard, propCards, characterReferences, sceneSnapshot,
    }
  },
})

type FrameReferenceType = 'init' | 'style' | 'character' | 'content'
interface FrameReferenceEntry { label: string; url: string; type: FrameReferenceType }

/**
 * 组装本次生成的参考图（带语义类型），顺序固定为
 * init（图生图输入）→ style（画风）→ character（角色）→ content（场景/道具等内容图）。
 * 这个顺序就是 generateFrame 的传图顺序，所以 prompt 里的「图N」标签与实际请求一一对应。
 */
function generationReferences(input: Prepared, frame: 'start' | 'end', firstFrameUrl?: string) {
  const entries: FrameReferenceEntry[] = []
  const isContinuous = normalizeShotLink(input.plan.current).type === 'continuous'
  if (frame === 'end' && firstFrameUrl) {
    entries.push({
      label: '本镜首帧（图生图输入）：【以它为基础只改变动作与表情，人物、服装、场景、光线保持一致；本帧景别与取景以尾帧提示词为准，不得照搬其构图与画面范围】',
      url: firstFrameUrl, type: 'init',
    })
  }
  if (frame === 'start' && isContinuous && input.frameMode === 'dual' && input.plan.previous?.lastFrameUrl) {
    entries.push({
      label: '上一镜尾帧（图生图输入）：【延续其状态、空间关系、光线与场景，按本镜首帧提示词改变机位与动作】',
      url: input.plan.previous.lastFrameUrl, type: 'init',
    })
  }
  // 风格锚：作品画风的参考图
  if (input.styleProfile.referenceUrl) {
    entries.push({ label: '风格参考图：【整体沿用其画风、材质质感与色彩倾向，不得改变】', url: input.styleProfile.referenceUrl, type: 'style' })
  }
  // 角色参考：同一角色同一次生成复用同一张图（characterReferences 已按 cur_image_id 固定）
  for (const ref of input.characterReferences) {
    if (ref.asset_url) {
      entries.push({ label: `角色参考图：【角色ID ${ref.role_id}：保持其面部、发型、服饰、体型与年龄一致，禁止改动】`, url: ref.asset_url, type: 'character' })
    }
  }
  // 单帧模式下，若同场景上一镜已有主帧图，作为空间环境连贯参考传入 content（不锁死机位，但保证门窗开关、光影与房间陈设一致）
  const seen = new Set(entries.map(entry => entry.url).filter(Boolean))
  if (frame === 'start' && input.frameMode === 'single' && isContinuous) {
    const prevFrameUrl = String(input.plan.previous?.lastFrameUrl || input.plan.previous?.firstFrameUrl || '').trim()
    if (prevFrameUrl && !seen.has(prevFrameUrl)) {
      seen.add(prevFrameUrl)
      entries.push({
        label: '上一镜画面参考：【保持同场景空间布局、光影色温与门窗/道具状态一致，按本镜首帧提示词推进机位与动作】',
        url: prevFrameUrl,
        type: 'content',
      })
    }
  }
  // 其余素材参考（场景、道具等），按 URL 去重
  for (const ref of input.assetReferences) {
    if (!ref.url || seen.has(ref.url)) continue
    seen.add(ref.url)
    entries.push({ label: ref.label, url: ref.url, type: 'content' })
  }
  return {
    entries,
    /** 编号后的标签，供 prompt 直接拼装 */
    references: numberFrameReferences(entries.map(({ label, url }) => ({ label, url }))),
  }
}

/** 出图：组装 prompt → 调公共出图工具（frame-gen）→ 返回图片与种子。 */
async function renderFrame(input: Prepared, frame: 'start' | 'end', firstFrameUrl?: string) {
  const { entries, references } = generationReferences(input, frame, firstFrameUrl)
  const urlsOf = (type: FrameReferenceType) => entries.filter(entry => entry.type === type).map(entry => entry.url)
  const worldState = String(input.plan.current.world_state || '').trim()
  // 只保留模型真正需要的东西：编号映射 + 本帧画面描述 + 全局风格锚 + 角色一致性约束 + 不可逆状态锁。
  const prompt = [
    `只生成本镜${frame === 'start' ? '首' : '尾'}帧的一张画面，不要拼图。参考图编号与实际传图顺序一致：`,
    references.map(ref => ref.label).join('\n'),
    '本镜出镜角色：' + input.plan.current.roles.map(role => role.id).join('、') + '。不要增加其他角色。',
    // 尾帧常被要求"推近/收紧"，模型容易直接复刻作为参考图的首帧构图，这里显式给出重取景授权
    frame === 'end'
      ? '景别与取景（必须执行）：本帧的景别、机位与画面范围以本提示词的【镜头】【画面构图】为准。若其中要求更近的取景（推镜头、景别收档、"画面收紧""更充满画面"或只拍某部位）或切换了机位角度，必须据此重新裁切构图——放大主体、收窄画面、裁掉多余环境；参考图中的画面范围与人物占幅只是首帧的构图，不得据此把主体画小或退回更宽的景别。'
      : '',
    // 全局风格锚：原文 + 硬性风格声明
    `【全局风格】${input.styleProfile.prompt}\nAll frames MUST follow this exact style.`,
    // 角色设定卡：外貌锁死，跨帧身份一致
    input.characterCards.length
      ? '【角色设定卡】\n' + input.characterCards.map(card => card.text).join('\n')
        + '\nThese characters MUST look identical across ALL frames they appear in. Do NOT change their outfit, hair color, age, or body proportions.'
      : '',
    input.sceneCard ? `【场景设定卡】${input.sceneCard.text}` : '',
    // 道具设定卡：本镜出现的道具的外观依据（没有道具时整段省略）
    input.propCards.length ? '【道具设定卡】\n' + input.propCards.map(card => card.text).join('\n') : '',
    worldState ? `【当前不可逆状态锁（最高优先级，覆盖场景/道具设定卡的初始静态描述）】\n${worldState}` : '',
    frame === 'start' ? input.plan.current.start_prompt : input.plan.current.end_prompt,
    '禁止在画面中绘制文字、气泡、Z 字等漫画符号；不要拼图或多格分镜。',
  ].filter(Boolean).join('\n')
  // 作品级宽高比：档位（2K/3K…）要与它一起查表，才能得出供应商要的像素值，锁定出图比例
  const [work] = await db.select({ aspectRatio: schema.works.aspect_ratio })
    .from(schema.works).where(eq(schema.works.id, input.workId)).limit(1)

  // init_image：尾帧以本镜首帧为图生图输入；首帧（场景第一镜、单帧模式或 cut/transition 镜头）无输入帧，走文生图+多图参考。
  const initImage = urlsOf('init')[0]
  return generateFrameImage({
    prompt,
    negative_prompt: sanitizeShotNegativePrompt(input.plan.current.negative_prompt),
    init_image: initImage,
    style_reference: urlsOf('style')[0],
    character_references: urlsOf('character').map(url => ({ url })),
    content_references: urlsOf('content').map(url => ({ url })),
    model: input.model, quality: input.quality, resolution: input.resolution,
    aspectRatio: work?.aspectRatio || undefined,
    label: `分镜${frame === 'start' ? '首' : '尾'}帧`,
  })
}

const generateFirstFrame = createStep({ id: 'generate-first-frame', inputSchema: preparedSchema, outputSchema: startSchema,
  execute: async ({ inputData }) => {
    // 链式复用：仅在双帧模式（dual）且 link.type === 'continuous' 时，本镜首帧直接继承上一镜尾帧；
    // 单帧模式（single）下每镜只生成本镜自己的 1 张主关键帧（首帧），不再依赖上一镜尾帧。
    const isContinuous = normalizeShotLink(inputData.plan.current).type === 'continuous'
    const inherited = (inputData.frameMode === 'dual' && isContinuous)
      ? inputData.plan.previous?.lastFrameUrl?.trim()
      : ''
    if (inherited) {
      console.log(`本镜首帧继承上一镜尾帧（不重复生成）：${inherited}`)
      return { ...inputData, firstFrameUrl: inherited, firstFrameSeed: null, inheritedFirstFrame: true }
    }
    const { url, seed } = await renderFrame(inputData, 'start')
    if (inputData.frameMode === 'single' && imageDryRunEnabled()) {
      throw new Error('DRY_RUN：单帧模式首帧请求体已打印，未提交供应商（确认无误后关掉 IMAGE_DRY_RUN / VIDEO_DRY_RUN 再正式生成）')
    }
    return { ...inputData, firstFrameUrl: url, firstFrameSeed: seed, inheritedFirstFrame: false }
  } })

const generateLastFrame = createStep({ id: 'generate-last-frame', inputSchema: startSchema, outputSchema: endSchema,
  execute: async ({ inputData }) => {
    // 市场主流单关键帧模式（single）：不生成尾帧，直接用单张首帧 + 动作演进驱动视频，消除首尾两张 AI 图对不齐的问题
    if (inputData.frameMode === 'single') {
      return { ...inputData, lastFrameUrl: '', lastFrameSeed: null }
    }
    const { url, seed } = await renderFrame(inputData, 'end', inputData.firstFrameUrl)
    if (imageDryRunEnabled()) {
      throw new Error('DRY_RUN：首尾帧请求体已打印，未提交供应商（确认无误后关掉 IMAGE_DRY_RUN / VIDEO_DRY_RUN 再正式生成）')
    }
    return { ...inputData, lastFrameUrl: url, lastFrameSeed: seed }
  } })

const saveFrames = createStep({ id: 'save-frames', inputSchema: endSchema, outputSchema,
  execute: async ({ inputData }) => {
    const { firstFrameUrl, lastFrameUrl, firstFrameSeed, lastFrameSeed, frameMode } = inputData
    let resolvedSceneIdx = 0
    let resolvedShotIdx = inputData.panelIdx
    await modifyPanelInTx(inputData.chapterId, inputData.panelIdx, async (panel, configs, target) => {
      if (target?.sceneIdx !== undefined) {
        resolvedSceneIdx = target.sceneIdx
        resolvedShotIdx = Array.isArray(target.scene?.shots)
          ? Math.max(0, target.scene.shots.indexOf(target.shot))
          : inputData.panelIdx
      }
      const run = panel.redrawRun
      if (run?.id !== inputData.runId || run.status !== 'charged') throw new Error('重绘任务已失效，未覆盖图片')
      const plan = frameContinuityPlan(configs, inputData.panelIdx, { frameMode })
      if (framePlanSnapshot(plan) !== inputData.snapshot || run.snapshot !== inputData.snapshot)
        throw new Error('分镜或相邻画面已变化，请重新生成')
      if (!Number.isFinite(run.imageUnitCost)) throw new Error('重绘计费信息无效')
      const actualGeneratedCount = frameMode === 'single'
        ? (inputData.inheritedFirstFrame ? 0 : 1)
        : (inputData.inheritedFirstFrame ? 1 : REDRAW_FRAME_COUNT)
      run.usedCost = actualGeneratedCount * run.imageUnitCost
      if (run.usedCost > run.cost) throw new Error('重绘费用超出预扣金额')
      if (String(panel.firstFrameUrl || '') !== firstFrameUrl || String(panel.lastFrameUrl || '') !== lastFrameUrl) {
        panel.finalVideoUrl = ''
      }

      const scene = target?.scene
      const shot = target?.shot
      if (target?.sceneIdx === undefined || !scene || !shot) {
        panel.firstFrameUrl = firstFrameUrl
        panel.lastFrameUrl = lastFrameUrl
      } else {
        assignPanelFrame(scene, panel, 'start', { url: firstFrameUrl, seed: firstFrameSeed })
        assignPanelFrame(scene, panel, 'end', lastFrameUrl ? { url: lastFrameUrl, seed: lastFrameSeed } : null)
      }

      // 冗余快照：本次生成实际使用的全局风格 / 角色参考图 / 场景设定，供复现与排查
      panel.style_prompt_snapshot = inputData.styleProfile.prompt
      panel.character_references_snapshot = inputData.characterReferences
      panel.scene_reference_snapshot = inputData.sceneSnapshot

      // 链式一致：仅在双帧模式（dual）且下一镜为 continuous 时，把本镜尾帧同步作为下一镜首帧
      if (frameMode === 'dual' && plan.next && lastFrameUrl && normalizeShotLink(plan.next).type === 'continuous') {
        const neighbor = resolveStoryboardPanel(configs, plan.next.panelIdx)
        if (neighbor?.panel && neighbor.shot) {
          const neighborUrl = shotFrameUrl(neighbor.scene, neighbor.shot, 'start')
          const sharedRef = target?.sceneIdx === undefined
            ? ''
            : shotFrameRef(panel, 'end')
          if (neighborUrl !== lastFrameUrl || (sharedRef && shotFrameRef(neighbor.shot, 'start') !== sharedRef)) {
            if (neighbor.sceneIdx === undefined) neighbor.panel.firstFrameUrl = lastFrameUrl
            else assignPanelFrame(neighbor.scene, neighbor.panel, 'start', { url: lastFrameUrl, seed: lastFrameSeed })
            neighbor.panel.finalVideoUrl = ''
            neighbor.commit()
          }
        }
      }
    })
    if (firstFrameUrl) {
      await recordShotAssetVersion({
        chapterId: inputData.chapterId,
        sceneIndex: resolvedSceneIdx,
        shotIndex: resolvedShotIdx,
        assetType: 'first_frame',
        url: firstFrameUrl,
        prompt: inputData.plan.current.start_prompt,
        modelKey: inputData.model,
        params: { resolution: inputData.resolution, quality: inputData.quality, seed: firstFrameSeed, frameMode },
        status: 'done',
      })
    }
    if (lastFrameUrl) {
      await recordShotAssetVersion({
        chapterId: inputData.chapterId,
        sceneIndex: resolvedSceneIdx,
        shotIndex: resolvedShotIdx,
        assetType: 'last_frame',
        url: lastFrameUrl,
        prompt: inputData.plan.current.end_prompt || '',
        modelKey: inputData.model,
        params: { resolution: inputData.resolution, quality: inputData.quality, seed: lastFrameSeed, frameMode },
        status: 'done',
      })
    }
    return { firstFrameUrl, lastFrameUrl }
  } })

export const frameRedrawWorkflow = createWorkflow({ id: 'frame-redraw', inputSchema, outputSchema })
  .then(prepareReferences).then(generateFirstFrame).then(generateLastFrame).then(saveFrames).commit()
