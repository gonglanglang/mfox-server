import { LLMJSON } from '../../../tools/index'
import { PromptBudget } from '../../../tools/llm-call'
import { assetFrameReferences, numberFrameReferences } from '../../../tools/frame-prompts'
import { normalizeShotLink } from '../../../tools/storyboard-text'
import { applyRenderedShots, resolveShotFrameIndices } from './index'
import {
  buildCharacterCard, buildCharacterReferences, buildPropCard, buildSceneCard, DEFAULT_STYLE_PROMPT,
} from '../../../tools/storyboard-assets'

// ============================================
// 首尾帧提示词流水线（以场景为原子单位）
// 每个镜头的 content / motion.in 是一个"确定瞬间的画面"，
// - 当相邻镜头为 continuous 时，交界帧同时作为上一镜终点与本镜起点；
// - 当相邻镜头为 cut / transition 时，交界帧作为本镜独立首帧（start_only），附带视觉/视线衔接锚点（link_anchor）。
// 渲染器负责把帧状态扩写成 8 段画面描述，格式不对就按批就地重试。
// ============================================

type EvidenceAsset = {
  id: number
  type: string
  name?: string
  description?: string
  detail?: Record<string, unknown> | null
  gender?: string
  age?: string
  image?: string
  imageId?: string | null
  /** 人物身高（cm）：渲染提示词时的尺度锚点 */
  height?: number | null
}

/** 渲染阶段的模型调用：由 step 注入真实 agent，测试注入假实现。 */
export interface PromptPipelineAgents {
  render(payload: string, signal: AbortSignal): Promise<string>
}

export interface ScenePromptPipelineOptions {
  sceneIndex: number
  /** 场景总数，仅用于进度文案 */
  sceneCount: number
  configs: any[]
  evidence: { assets?: EvidenceAsset[] }
  style?: { name?: string; description?: string; effectImage?: string }
  /** 作品画风（works.style_id → visual_styles）：description + effect_image；缺省回退 DEFAULT_STYLE_PROMPT */
  styleProfile?: { prompt?: string; referenceUrl?: string }
  agents: PromptPipelineAgents
  progress?: (label: string) => void | Promise<void>
  /** 场景内每批渲染的镜头数上限（默认 2） */
  batchSize?: number
  /** 本场景共享的时间预算（默认 600s，只作用于当前场景） */
  budgetMs?: number
  renderTimeoutMs?: number
  /** 单批渲染的最大尝试次数（默认 3） */
  maxRenderAttempts?: number
}

export interface ScenePromptPipelineResult {
  configs: any[]
  boundaryCount: number
  reviewRounds: number
  renderCalls: number
}

const DEFAULTS = {
  batchSize: 2, // 单批渲染镜头数：3→2，降低单次 JSON 输出量，减少截断/格式失败
  budgetMs: 600_000,
  renderTimeoutMs: 360_000,
  maxRenderAttempts: 3,
}

/** 模型文本 → JSON；LLMJSON 支持代码块与前后说明文字。 */
function parseModelJSON(text: string): unknown {
  const value = LLMJSON(String(text || '').trim())
  if (value === null || value === undefined) throw new Error('模型没有返回可解析的 JSON')
  return value
}

function numericIds(values: unknown[]): number[] {
  return [...new Set(values.map(value => Number(value)).filter(Number.isSafeInteger))]
}

/** 只保留模型需要的镜头信息：剧本内容、台词、镜头参数与素材引用。 */
function shotInput(shot: Record<string, any>, index: number) {
  return {
    shot_index: index,
    content: String(shot.content || ''),
    dialogue: Array.isArray(shot.dialogue)
      ? shot.dialogue.map((line: any) => ({
        speaker: String(line?.speaker || ''),
        text: String(line?.text || ''),
        tone: String(line?.tone || ''),
        emotion: String(line?.emotion || ''),
      }))
      : [],
    shot_size: String(shot.shot_size || ''),
    camera_angle: String(shot.camera_angle || ''),
    camera_movement: String(shot.camera_movement || ''),
    roles: numericIds((Array.isArray(shot.roles) ? shot.roles : []).map((role: any) => role?.id)),
    prop_ids: numericIds(Array.isArray(shot.prop_ids) ? shot.prop_ids : []),
  }
}

/** 按 ID 从素材快照取外观描述（渲染器需要名称与 ID，而不是内部数字）。 */
function pickAssets(assets: EvidenceAsset[], ids: number[], type: string) {
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  return ids.flatMap(id => {
    const asset = byId.get(id)
    return asset && asset.type === type
      ? [{ id: asset.id, name: asset.name || '', height: asset.height ?? null, description: asset.description || '', image: asset.image || '' }]
      : []
  })
}

/**
 * 完成一个场景的首尾帧提示词：派生帧状态 → 分批渲染 → 写入冗余快照。
 * 任一阶段失败都抛错（不返回半成品），错误消息带场景与阶段信息。
 */
export async function fillScenePrompts(options: ScenePromptPipelineOptions): Promise<ScenePromptPipelineResult> {
  const { sceneIndex, sceneCount, configs, agents, progress } = options
  const scene = configs[sceneIndex]
  if (!scene) throw new Error(`场景不存在：${sceneIndex}`)
  const shots: Record<string, any>[] = Array.isArray(scene.shots) ? scene.shots : []
  if (!shots.length) throw new Error(`场景 ${sceneIndex + 1} 没有镜头，无法生成首尾帧提示词`)

  const batchSize = options.batchSize ?? DEFAULTS.batchSize
  const maxRenderAttempts = options.maxRenderAttempts ?? DEFAULTS.maxRenderAttempts
  const renderTimeoutMs = options.renderTimeoutMs ?? DEFAULTS.renderTimeoutMs
  const sceneLabel = `场景 ${sceneIndex + 1}/${sceneCount}`
  const budget = new PromptBudget(`${sceneLabel} 首尾帧提示词`, options.budgetMs ?? DEFAULTS.budgetMs)
  const notify = async (label: string) => { await progress?.(`${sceneLabel}：${label}`) }

  const sceneSummary = {
    scene_id: scene.scene_id,
    environment: String(scene.environment || ''),
    transition: String(scene.transition || ''),
  }
  const sceneRoleIds = numericIds((Array.isArray(scene.roles) ? scene.roles : []).map((role: any) => role?.id))
  const scenePropIds = numericIds(Array.isArray(scene.prop_ids) ? scene.prop_ids : [])
  const shotInputs = shots.map((shot, index) => shotInput(shot, index))
  const assets = options.evidence.assets || []
  // 素材集合 = 场景级角色 + 场景级道具 + 场景本身 + 各镜角色与道具
  const sceneAssetId = Number(scene.scene_id)
  const usedAssetIds = new Set([
    ...sceneRoleIds, ...scenePropIds,
    ...(Number.isSafeInteger(sceneAssetId) && sceneAssetId > 0 ? [sceneAssetId] : []),
    ...shotInputs.flatMap(shot => [...shot.roles, ...shot.prop_ids]),
  ])
  const assetReferences = numberFrameReferences(assetFrameReferences(
    assets.filter(asset => usedAssetIds.has(asset.id)),
  ))

  // ── 全局风格锚（作品画风）+ 角色/场景/道具设定卡（渲染器输入）──
  const stylePrompt = String(options.styleProfile?.prompt || '').trim() || DEFAULT_STYLE_PROMPT
  const styleReferenceUrl = String(options.styleProfile?.referenceUrl || '').trim()
  const usedAssets = assets.filter(asset => usedAssetIds.has(asset.id))
  const characterCards = usedAssets
    .filter(asset => asset.type === 'persona')
    .map(buildCharacterCard)
    .filter((card): card is NonNullable<typeof card> => card !== null)
  const sceneAsset = usedAssets.find(asset => asset.type === 'scene'
    && String(asset.id) === String(scene.scene_id))
  const sceneCard = sceneAsset ? buildSceneCard(sceneAsset) : null
  const propCards = usedAssets
    .filter(asset => asset.type === 'prop')
    .map(buildPropCard)
    .filter((card): card is NonNullable<typeof card> => card !== null)

  /**
   * 在预算内调用模型并把“解析/校验失败”作为反馈重试；
   * 超时与预算耗尽属于基础设施错误，直接抛出（重试只会再烧一次预算）。
   */
  async function callModel<T>(
    label: string,
    timeoutMs: number,
    attempts: number,
    build: (feedback: string) => string,
    invoke: (payload: string, signal: AbortSignal) => Promise<string>,
    parse: (value: unknown) => T,
  ): Promise<{ value: T; attempts: number }> {
    let feedback = ''
    for (let attempt = 0; attempt < attempts; attempt++) {
      const attemptLabel = attempt === 0 ? label : `${label}（第 ${attempt + 1} 次，修正上一轮格式问题）`
      await notify(attemptLabel)
      const text = await budget.call(attemptLabel, signal => invoke(build(feedback), signal), timeoutMs)
      try {
        const value = parse(parseModelJSON(text))
        return { value, attempts: attempt + 1 }
      } catch (error) {
        const message = error instanceof Error ? error.message : '输出格式错误'
        // 最后一次仍未通过：带上阶段上下文抛出（超时与预算错误不在此分支，原样冒泡）
        if (attempt === attempts - 1) throw new Error(`${label} 连续 ${attempts} 次未通过：${message}`)
        feedback = message
        console.warn(`[${sceneLabel}] ${label} 第 ${attempt + 1} 次输出无效，重试：${feedback}`)
        await notify(`${label} 输出格式未通过：${feedback}`)
      }
    }
    throw new Error(`${sceneLabel} ${label} 未产出有效结果`)
  }

  // ---------- 1. 派生帧状态序列 ----------
  const spans = resolveShotFrameIndices(shots)
  const startStates = shots.map((shot: Record<string, any>) =>
    String(shot.motion?.in || shot.image_prompt || shot.content || '').trim(),
  )
  const endStates = shots.map((shot: Record<string, any>, idx: number) =>
    String(shot.motion?.out || startStates[idx] || '').trim(),
  )
  const boundaryCount = spans.length ? spans[spans.length - 1]!.endFrameIndex + 1 : 0
  const reviewRounds = 0

  /** 构造指定镜头 s 的起始帧（start_only / scene_opening_start / shot_boundary）描述 */
  function buildStartFrame(shotIdx: number, frameIndex: number) {
    const base = shotInputs[shotIdx]!
    const currentShot = (shots[shotIdx] || {}) as Record<string, any>
    const prevShot = shotIdx > 0 ? ((shots[shotIdx - 1] || {}) as Record<string, any>) : null
    const link = normalizeShotLink(currentShot)
    const isCutOrTransition = shotIdx > 0 && link.type !== 'continuous'
    const curMotionText = String(currentShot.motion?.path || currentShot.motion_prompt || currentShot.subject_motion || '')
    const prevMotionText = String(prevShot?.motion?.path || prevShot?.motion_prompt || prevShot?.subject_motion || '')

    return {
      frame_index: frameIndex,
      state: startStates[shotIdx] ?? '',
      frame_role: shotIdx === 0
        ? 'scene_opening_start'
        : isCutOrTransition
          ? 'start_only'
          : 'shot_boundary',
      ...(shotIdx > 0
        ? {
          link_type: link.type,
          ...(link.match ? { link_match: link.match } : {}),
          ...(link.anchor ? { link_anchor: link.anchor } : {}),
          prev_state: startStates[shotIdx - 1] ?? '',
          prev_motion: prevMotionText,
          upcoming_motion: curMotionText,
          ...(prevShot?.motion?.out ? { prev_motion_out: String(prevShot.motion.out) } : {}),
          ...(currentShot.motion?.in ? { motion_in: String(currentShot.motion.in) } : {}),
        }
        : {
          upcoming_motion: curMotionText,
          ...(currentShot.motion?.in ? { motion_in: String(currentShot.motion.in) } : {}),
        }),
      ...(currentShot.axis_side ? { axis_side: currentShot.axis_side } : {}),
      ...(currentShot.eyeline ? { eyeline: currentShot.eyeline } : {}),
      ...(currentShot.continuity?.light_dir ? { light_dir: currentShot.continuity.light_dir } : {}),
      ...(currentShot.subject_id != null ? { subject_id: currentShot.subject_id } : {}),
      ...(currentShot.color_tone ? { color_tone: currentShot.color_tone } : {}),
      ...(currentShot.motion_direction ? { motion_direction: currentShot.motion_direction } : {}),
      ...(currentShot.world_state ? { world_state: currentShot.world_state } : {}),
      ...(currentShot.prev_shot_summary ? { prev_shot_summary: currentShot.prev_shot_summary } : {}),
      shot_size: base.shot_size, camera_angle: base.camera_angle, camera_movement: base.camera_movement,
      roles: pickAssets(assets, [...new Set([...sceneRoleIds, ...base.roles])], 'persona'),
      props: pickAssets(assets, [...new Set([...scenePropIds, ...base.prop_ids])], 'prop'),
    }
  }

  /** 构造指定镜头 s 独立收尾帧（切镜前的 end_only 或场景末尾的 scene_closing_end）描述 */
  function buildIndependentEndFrame(shotIdx: number, frameIndex: number) {
    const base = shotInputs[shotIdx]!
    const currentShot = (shots[shotIdx] || {}) as Record<string, any>
    const isSceneClosing = shotIdx === shots.length - 1
    const curMotionText = String(currentShot.motion?.path || currentShot.motion_prompt || currentShot.subject_motion || '')

    return {
      frame_index: frameIndex,
      state: endStates[shotIdx] ?? '',
      frame_role: isSceneClosing ? 'scene_closing_end' : 'end_only',
      ...(currentShot.axis_side ? { axis_side: currentShot.axis_side } : {}),
      ...(currentShot.eyeline ? { eyeline: currentShot.eyeline } : {}),
      ...(currentShot.continuity?.light_dir ? { light_dir: currentShot.continuity.light_dir } : {}),
      ...(currentShot.subject_id != null ? { subject_id: currentShot.subject_id } : {}),
      ...(currentShot.color_tone ? { color_tone: currentShot.color_tone } : {}),
      ...(currentShot.motion_direction ? { motion_direction: currentShot.motion_direction } : {}),
      ...(currentShot.world_state ? { world_state: currentShot.world_state } : {}),
      shot_size: base.shot_size, camera_angle: base.camera_angle, camera_movement: base.camera_movement,
      roles: pickAssets(assets, [...new Set([...sceneRoleIds, ...base.roles])], 'persona'),
      props: pickAssets(assets, [...new Set([...scenePropIds, ...base.prop_ids])], 'prop'),
      final_of_shot: true,
      motion: curMotionText,
      ...(currentShot.motion?.out ? { motion_out: String(currentShot.motion.out) } : {}),
    }
  }

  // ---------- 2. 分批渲染 ----------
  let updated = configs
  let renderCalls = 0
  const renderedFrameCache = new Map<number, { prompt: string; negative_prompt: string }>()
  for (let start = 0; start < shots.length; start += batchSize) {
    const size = Math.min(batchSize, shots.length - start)
    const range = `${start + 1}-${start + size}`
    const batchFrames: Record<string, unknown>[] = []
    const addedFrameIndices = new Set<number>()

    for (let offset = 0; offset < size; offset++) {
      const shotIdx = start + offset
      const span = spans[shotIdx]!
      if (!addedFrameIndices.has(span.startFrameIndex) && !renderedFrameCache.has(span.startFrameIndex)) {
        addedFrameIndices.add(span.startFrameIndex)
        batchFrames.push(buildStartFrame(shotIdx, span.startFrameIndex))
      }
      if (!addedFrameIndices.has(span.endFrameIndex) && !renderedFrameCache.has(span.endFrameIndex)) {
        if (!span.sharesEndWithNext) {
          // 下一镜为 cut/transition 或本镜是场景末镜：本镜拥有独立尾帧（保持本镜机位与景别，演完本镜动作）
          addedFrameIndices.add(span.endFrameIndex)
          batchFrames.push(buildIndependentEndFrame(shotIdx, span.endFrameIndex))
        } else if (shotIdx + 1 >= start + size) {
          // 下一镜为 continuous 且位于下一批次：把共享交界帧加入本批尾部
          addedFrameIndices.add(span.endFrameIndex)
          batchFrames.push(buildStartFrame(shotIdx + 1, span.endFrameIndex))
        }
      }
    }
    const payload = {
      scene: sceneSummary,
      style: options.style || {},
      global_style: { prompt: stylePrompt, reference_url: styleReferenceUrl },
      character_cards: characterCards,
      scene_card: sceneCard,
      prop_cards: propCards,
      assetReferences,
      frames: batchFrames,
    }
    const rendered = await callModel(`渲染首尾帧提示词（镜头 ${range}）`, renderTimeoutMs, maxRenderAttempts,
      feedback => JSON.stringify(feedback ? { ...payload, feedback } : payload),
      agents.render,
      value => applyRenderedShots(updated, { sceneIndex, batchStart: start, batchSize: size }, value, renderedFrameCache))
    updated = rendered.value
    renderCalls += rendered.attempts
  }

  // ── 冗余快照：把本轮渲染实际使用的风格/角色/场景写回每个镜头，供重绘复现与排查 ──
  // 同一角色固定用其当前选中图（cur_image_id），同一次生成复用同一张 reference_image。
  const finalScene = updated[sceneIndex]
  if (finalScene && Array.isArray(finalScene.shots)) {
    const sceneSnapshot = sceneCard ? {
      scene_id: Number(sceneCard.id) || null,
      text: sceneCard.text,
      image_url: sceneCard.imageUrl,
    } : null
    const assetById = new Map(assets.map(a => [String(a.id), a]))
    updated = updated.map((config, index) => index !== sceneIndex ? config : ({
      ...config,
      shots: config.shots.map((shot: Record<string, any>) => {
        const charRefsSnapshot = buildCharacterReferences(
          [...sceneRoleIds, ...(Array.isArray(shot.roles) ? shot.roles.map((role: any) => role?.id) : [])],
          assets,
        )
        const existingCharRefs = Array.isArray(shot.character_refs) && shot.character_refs.length > 0
          ? shot.character_refs
          : charRefsSnapshot.map(ref => {
            const asset = assetById.get(String(ref.role_id))
            return {
              role_id: String(ref.role_id),
              name: String(asset?.name || ref.role_id),
              description: ref.description,
              ...(ref.asset_url ? { image_url: ref.asset_url } : {}),
            }
          })
        return {
          ...shot,
          style_prompt_snapshot: stylePrompt,
          scene_reference_snapshot: sceneSnapshot,
          // 帧渲染时使用「场景级角色 + 本镜角色」并集，快照与之一致
          character_references_snapshot: charRefsSnapshot,
          ...(existingCharRefs.length > 0 ? { character_refs: existingCharRefs } : {}),
        }
      }),
    }))
  }

  return { configs: updated, boundaryCount, reviewRounds, renderCalls }
}
