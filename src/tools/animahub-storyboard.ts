import {
  parseStoryboardText,
  parseGenMode,
  normalizeShotLink,
  resolveSpeakerRoleId,
  sanitizeDialogueList,
  type SpeakerCharacter,
  type TextStoryboardScene,
  type TextStoryboardShot,
} from './storyboard-text'
import {
  buildCharacterCard,
  buildCharacterReferences,
  buildPropCard,
  buildSceneCard,
  DEFAULT_STYLE_PROMPT,
  type CardAsset,
} from './storyboard-assets'
import { safeJsonParse, stripLeadingStylePrefix } from './animahub-json'

/**
 * AnimaHub 核心剧本节奏规划、双格式分镜解析与 `{ prev, curr, next }` 滑动窗口提示词推理引擎
 *
 * 吸收自 AnimaHub：
 * - `lib/script-workshop/prompt.ts` (`estimateShotsPerEpisode` 与短剧钩子/推进/悬念节奏控制)
 * - `.docs/storyboard_templates_schema.sql` (`shot_split_rules`: `by_dialogue`, `by_action`, `by_scene_change`, `by_time_limit`)
 * - `StoryboardWorkbench.tsx` / `InferEndFrameModal.tsx` (`{ prev, curr, next }` 上下文推理 + 首帧与运动推导尾帧)
 */

export interface ShotSplitRules {
  by_dialogue: boolean
  by_action: boolean
  by_scene_change: boolean
  by_time_limit: boolean
  max_shot_sec: number
  min_shot_sec: number
}

export interface ChapterStoryboardRhythmPlan {
  wordCount: number
  estimatedDurationSec: number
  avgShotSec: number
  targetShots: number
  minShots: number
  maxShots: number
  splitRules: ShotSplitRules
  rhythmDirective: string
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * 按章节字数与对白密度测算目标时长与镜头数（移植自 AnimaHub `estimateShotsPerEpisode`）。
 * 防止章节过长拆出数十个碎镜头导致输出截断，或章节过短拆成静态PPT镜头。
 */
export function estimateChapterStoryboardPlan(
  text: string,
  options?: {
    avgShotSec?: number
    minShots?: number
    maxShots?: number
  },
): ChapterStoryboardRhythmPlan {
  const clean = String(text || '').replace(/\s+/g, '')
  const wordCount = clean.length
  const avgShotSec = options?.avgShotSec && options.avgShotSec > 0 ? options.avgShotSec : 4.2

  // 中文漫剧语速与动作密度：约每 16~20 字对应 1 秒有效视听时长，限制单章合理区间 28s ~ 150s
  const rawDurationSec = Math.max(28, Math.min(150, Math.round(wordCount / 18)))
  const targetShots = clampInt(
    rawDurationSec / avgShotSec,
    options?.minShots ?? 4,
    options?.maxShots ?? 32,
  )
  const minShots = Math.max(3, Math.floor(targetShots * 0.75))
  const maxShots = Math.min(36, Math.ceil(targetShots * 1.25))

  const splitRules: ShotSplitRules = {
    by_dialogue: true,
    by_action: true,
    by_scene_change: true,
    by_time_limit: true,
    min_shot_sec: 2,
    max_shot_sec: 7,
  }

  const rhythmDirective = [
    `【AnimaHub 短剧节奏与拆镜规范】`,
    `- 建议本章总时长约 ${rawDurationSec}s，目标总镜头数约 ${targetShots} 镜（合理区间 ${minShots}~${maxShots} 镜，平均约 ${avgShotSec}s/镜）。`,
    `- 开场强钩子（前 3~5 秒 / 第 1~2 镜）：必须直接切入视觉反常、核心冲突或正在发生的动作，严禁静态罚站铺垫。`,
    `- 连续推进节奏：每 3~5 个镜头必须产生一次明确的信息增量、情绪递进或动作转折。`,
    `- 拆镜四准则（shot_split_rules）：① 按说话人轮次拆镜（正反打用 cut | eyeline）；② 按独立动作意图拆镜（单镜只承载一个起承转合动作，超过 7s 必须拆镜）；③ 地点/时间变化必须切分新场景；④ 结尾最后 1 镜必须落在情绪收束或悬念钩子（Cliffhanger）上。`,
  ].join('\n')

  return {
    wordCount,
    estimatedDurationSec: rawDurationSec,
    avgShotSec,
    targetShots,
    minShots,
    maxShots,
    splitRules,
    rhythmDirective,
  }
}

/**
 * 将结构化 JSON 分镜（AnimaHub `scenes` / `episode.shots` 形态）归一为 `TextStoryboardScene[]`。
 */
function normalizeStructuredScenes(
  data: any,
  characters?: SpeakerCharacter[],
): TextStoryboardScene[] {
  const rawScenes: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.scenes)
      ? data.scenes
      : Array.isArray(data?.episode?.shots)
        ? [{
            scene_id: String(data?.episode?.scene_id || '1'),
            environment: String(data?.episode?.title || data?.episode?.summary || '主场景'),
            transition: '淡出',
            bgm: '',
            shots: data.episode.shots,
          }]
        : Array.isArray(data?.shots)
          ? [{
              scene_id: String(data?.scene_id || '1'),
              environment: String(data?.environment || '主场景'),
              transition: String(data?.transition || '硬切'),
              bgm: String(data?.bgm || ''),
              shots: data.shots,
            }]
          : []

  if (!rawScenes.length) return []

  const charList = Array.isArray(characters) ? characters : []
  const out: TextStoryboardScene[] = []

  for (let scIdx = 0; scIdx < rawScenes.length; scIdx++) {
    const rawSc = rawScenes[scIdx]
    if (!rawSc || typeof rawSc !== 'object') continue
    const rawShots: any[] = Array.isArray(rawSc.shots) ? rawSc.shots : []
    if (!rawShots.length) continue

    const sceneRoles: { id: string }[] = Array.isArray(rawSc.roles)
      ? rawSc.roles
          .map((r: any) => String(typeof r === 'object' ? r?.id : r ?? '').trim())
          .filter(Boolean)
          .map((id: string) => ({ id }))
      : []
    const fallbackRoleId = String(rawSc.role_id || sceneRoles[0]?.id || charList[0]?.id || '').trim()

    const shots: TextStoryboardShot[] = []
    for (let shIdx = 0; shIdx < rawShots.length; shIdx++) {
      const s = rawShots[shIdx]
      if (!s || typeof s !== 'object') continue

      const content = String(
        s.content || s.visual || s.image_prompt || s.firstFramePrompt || s.plot_description || s.description || '',
      ).trim()
      if (!content) continue

      const imagePrompt = String(s.image_prompt || s.firstFramePrompt || s.start_prompt || content).trim()
      const motionPrompt = String(
        s.motion_prompt || s.videoPrompt || s.subject_motion || s.action || '',
      ).trim()
      const durNum = Number(s.durShort ?? s.durationSec ?? s.duration ?? 5)
      const durShort = Number.isFinite(durNum) ? clampInt(durNum, 2, 15) : 5

      // 归一化台词：兼容数组形式与 AnimaHub 的 `dialogue` / `narration` 字符串形式
      const rawDialogues: TextStoryboardShot['dialogue'] = []
      if (Array.isArray(s.dialogue)) {
        for (const d of sanitizeDialogueList(s.dialogue)) {
          const speaker = String(d?.speaker || '旁白').trim()
          const isNarr = /^旁白/.test(speaker)
          rawDialogues.push({
            id: isNarr ? fallbackRoleId : resolveSpeakerRoleId(speaker, String(d?.id || fallbackRoleId), charList),
            prop_ids: [],
            speaker,
            text: String(d?.text || '').trim(),
            tone: String(d?.tone || '').trim(),
            emotion: String(d?.emotion || (isNarr ? 'fluent' : 'calm')).trim(),
          })
        }
      } else {
        if (typeof s.narration === 'string' && s.narration.trim()) {
          rawDialogues.push({
            id: fallbackRoleId,
            prop_ids: [],
            speaker: '旁白',
            text: s.narration.trim(),
            tone: '平静',
            emotion: 'fluent',
          })
        }
        if (typeof s.dialogue === 'string' && s.dialogue.trim()) {
          const sep = s.dialogue.match(/^([^:：]+)[:：](.+)$/)
          const speaker = sep ? sep[1]!.trim() : '角色'
          const body = sep ? sep[2]!.trim() : s.dialogue.trim()
          if (body) {
            rawDialogues.push({
              id: resolveSpeakerRoleId(speaker, fallbackRoleId, charList),
              prop_ids: [],
              speaker,
              text: body,
              tone: '',
              emotion: 'calm',
            })
          }
        }
      }

      const shotRoles: { id: string }[] = Array.isArray(s.roles) && s.roles.length
        ? s.roles
            .map((r: any) => String(typeof r === 'object' ? r?.id : r ?? '').trim())
            .filter(Boolean)
            .map((id: string) => ({ id }))
        : sceneRoles.slice()

      const motionIn = String(s.motion?.in || imagePrompt || content).trim()
      const motionPath = String(s.motion?.path || motionPrompt || content).trim()
      const motionOut = String(s.motion?.out || s.end_prompt || s.lastFramePrompt || '').trim()
      const amplitude: 'micro' | 'small' | 'medium' =
        s.motion?.amplitude === 'micro' || s.motion?.amplitude === 'medium' || s.motion?.amplitude === 'small'
          ? s.motion.amplitude
          : durShort <= 3
            ? 'micro'
            : durShort >= 6
              ? 'medium'
              : 'small'

      shots.push({
        shot_size: String(s.shot_size || s.shotSize || '中景').trim(),
        camera_angle: String(s.camera_angle || s.cameraAngle || '正面机位').trim(),
        camera_movement: String(s.camera_movement || s.cameraMovement || '固定镜头').trim(),
        content,
        plot_description: String(s.plot_description || content).trim(),
        image_prompt: imagePrompt,
        start_prompt: String(s.start_prompt || s.firstFramePrompt || imagePrompt).trim(),
        end_prompt: String(s.end_prompt || s.lastFramePrompt || motionOut || '').trim(),
        motion_prompt: motionPrompt,
        subject_motion: String(s.subject_motion || motionPrompt || content).trim(),
        character_action: String(s.character_action || s.subject_motion || motionPrompt || '').trim(),
        dialogue: sanitizeDialogueList(rawDialogues),
        roles: shotRoles,
        sound_effect: String(s.sound_effect || s.sfx || '').trim(),
        durShort,
        key_prop_action: String(s.key_prop_action || '').trim(),
        link: normalizeShotLink(s),
        motion: {
          in: motionIn,
          path: motionPath,
          out: motionOut,
          amplitude,
        },
        ...(s.axis_side === 'A' || s.axis_side === 'B' ? { axis_side: s.axis_side } : {}),
        ...(s.eyeline ? { eyeline: String(s.eyeline).trim() } : {}),
        ...(s.lighting ? { lighting: String(s.lighting).trim() } : {}),
        ...(s.emotion ? { emotion: String(s.emotion).trim() } : {}),
        ...(s.scene_tags ? { scene_tags: Array.isArray(s.scene_tags) ? s.scene_tags.join(',') : String(s.scene_tags).trim() } : {}),
        ...(s.gen_mode || s.genMode
          ? { gen_mode: parseGenMode(s.gen_mode || s.genMode) || 'singleImage2video' }
          : {}),
      })
    }

    if (shots.length > 0) {
      out.push({
        scene_id: String(rawSc.scene_id || scIdx + 1).trim(),
        roles: sceneRoles,
        prop_ids: Array.isArray(rawSc.prop_ids)
          ? rawSc.prop_ids.map((p: any) => String(p).trim()).filter(Boolean)
          : [],
        role_id: fallbackRoleId,
        environment: String(rawSc.environment || rawSc.description || '场景环境').trim(),
        shots,
        transition: String(rawSc.transition || (scIdx === rawScenes.length - 1 ? '淡出' : '硬切')).trim(),
        bgm: String(rawSc.bgm || '').trim(),
      })
    }
  }

  return out
}

/**
 * 双模自愈分镜解析器（同时兼容 `【标签】` 文本块与 AnimaHub 结构化 JSON）。
 */
export function parseAnimaHubStoryboardOutput(
  raw: string,
  characters?: SpeakerCharacter[],
): { ok: true; value: TextStoryboardScene[] } | { ok: false; error: string } {
  const text = String(raw || '').trim()
  if (!text) {
    return { ok: false, error: 'AI 返回的分镜内容为空' }
  }

  // 路径 A：若包含【分镜序号】或【场景序号】，优先按截断可救的标签解析器解析
  if (text.includes('【分镜序号】') || text.includes('【镜头序号】') || text.includes('【场景序号】')) {
    try {
      // 若单场拆解漏写了【场景序号】，自动补齐头部的【场景序号】1 与默认【场景ID】1
      const normalizedTagged = text.includes('【场景序号】')
        ? text
        : `【场景序号】1\n【场景ID】1\n${text}`
      const parsed = parseStoryboardText(normalizedTagged, characters)
      if (parsed.length > 0 && parsed.some(sc => sc.shots.length > 0)) {
        return { ok: true, value: parsed }
      }
    } catch (tagErr: any) {
      return { ok: false, error: tagErr?.message || '分镜标签格式校验未通过' }
    }
  }

  // 路径 B：尝试 AnimaHub JSON 自愈解析
  const jsonParsed = safeJsonParse(text)
  if (jsonParsed.ok) {
    const structured = normalizeStructuredScenes(jsonParsed.value, characters)
    if (structured.length > 0) {
      return { ok: true, value: structured }
    }
  }

  return {
    ok: false,
    error: '未能从模型输出中解析出有效的场景与镜头块（需包含【场景序号】/【分镜序号】标签或合法 JSON scenes 数组）',
  }
}

export interface EndFrameInferenceInput {
  startPrompt: string
  motionPrompt?: string
  motionOut?: string
  cameraMovement?: string
  shotSize?: string
  cameraAngle?: string
  characterAction?: string
  keyPropAction?: string
  lighting?: string
  nextShotHint?: string
}

/**
 * 确定性尾帧提示词推理（移植自 AnimaHub `InferEndFrameModal` 核心思想）：
 * 基于首帧构图 + 本镜动态运动演进 (`motion.out` / `motion_prompt` / `camera_movement`) 推导本镜最后一秒的完成定格画面，
 * 彻底杜绝 `end_prompt === start_prompt` 造成的“首尾帧相同（C10）”与视频静止问题。
 */
export function inferEndFramePromptDeterministic(input: EndFrameInferenceInput): string {
  const start = String(input.startPrompt || '').trim()
  const explicitOut = String(input.motionOut || '').trim()
  const motion = String(input.motionPrompt || input.characterAction || '').trim()
  const camMove = String(input.cameraMovement || '').trim()
  const propAction = String(input.keyPropAction || '').trim()
  const lighting = String(input.lighting || '').trim()
  const shotSize = String(input.shotSize || '').trim()
  const cameraAngle = String(input.cameraAngle || '').trim()
  const nextHint = String(input.nextShotHint || '').trim()

  // 从 "in: ... -> path: ... -> out: ..." 或三段式文本中提取 out 段
  let extractedOut = explicitOut
  if (!extractedOut && motion) {
    const arrowOutMatch = motion.match(/(?:->|→)\s*(?:out\s*[:：]\s*)?([^->→]+)$/i)
    if (arrowOutMatch?.[1]?.trim()) {
      extractedOut = arrowOutMatch[1].trim()
    }
  }

  const framingShift = /推/.test(camMove)
    ? '镜头推进收紧后的更近景构图'
    : /拉/.test(camMove)
      ? '镜头拉远展开空间后的构图'
      : /摇|移|跟|环绕/.test(camMove)
        ? `${camMove}落定后的定格构图`
        : [shotSize, cameraAngle].filter(Boolean).join('，') || '保持同机位延续构图'

  const parts: string[] = []
  if (framingShift) parts.push(framingShift)

  if (extractedOut && extractedOut !== start) {
    parts.push(`动作完成定格态：${extractedOut.replace(/[。.]$/, '')}`)
  } else if (motion && motion !== start) {
    parts.push(`本镜动作演进完成后的收束瞬间（${motion.replace(/[。.]$/, '')}已完成落定）`)
  } else if (start) {
    parts.push(`${start.replace(/[。.]$/, '')}，人物神态与重心完成细微推进后的收束定格`)
  }

  if (propAction) {
    parts.push(`道具终态：${propAction.replace(/[。.]$/, '')}`)
  }
  if (lighting) {
    parts.push(`光影保持一致：${lighting}`)
  }
  if (nextHint) {
    parts.push(`视线/势能落点：${nextHint}`)
  }

  let candidate = parts.filter(Boolean).join('，')
  if (!candidate) {
    candidate = start ? `${start}（镜头末态收束定格）` : '镜头动作完成后的收束定格画面'
  }
  if (candidate.trim() === start) {
    candidate = `${candidate}，动作与眼神已完成推进并落定于镜头终点状态`
  }
  return candidate
}

/**
 * 确定性合成单镜结构化运动提示词（`in → path → out`），供 I2V / F2V / 多图融合直接驱动。
 */
export function synthesizeMotionPromptDeterministic(
  shot: Record<string, any>,
  prevShot?: Record<string, any> | null,
): string {
  const existing = String(shot.motion_prompt || shot.videoPrompt || '').trim()
  const camMove = String(shot.camera_movement || '固定镜头').trim()
  const mIn = String(shot.motion?.in || '').trim()
  const mPath = String(shot.motion?.path || shot.subject_motion || shot.character_action || '').trim()
  const mOut = String(shot.motion?.out || '').trim()
  const propAct = String(shot.key_prop_action || '').trim()
  const worldState = String(shot.world_state || '').trim()

  if (existing && (existing.length >= 16 || existing.includes('->') || existing.includes('→'))) {
    return existing
  }

  const segments: string[] = []
  if (camMove) segments.push(`${camMove}`)
  if (worldState) segments.push(`保持前序状态（${worldState}）`)
  if (mIn && mPath && mOut && mIn !== mOut) {
    segments.push(`从「${mIn.replace(/[。.]$/, '')}」开始，${mPath.replace(/[。.]$/, '')}，最终停在「${mOut.replace(/[。.]$/, '')}」`)
  } else if (mPath) {
    segments.push(mPath.replace(/[。.]$/, ''))
    if (mOut && mOut !== mPath) {
      segments.push(`最终落定于：${mOut.replace(/[。.]$/, '')}`)
    }
  } else if (existing) {
    segments.push(existing)
  } else if (shot.content) {
    segments.push(`${String(shot.content).replace(/[。.]$/, '')}，伴随自然呼吸起伏与眼神微动`)
  }

  if (propAct && !segments.some(seg => seg.includes(propAct))) {
    segments.push(propAct.replace(/[。.]$/, ''))
  }

  // 若是同场景 continuous 镜头且存在上一镜动作方向，补充顺接节拍但不重做上一镜动作
  if (prevShot && normalizeShotLink(shot).type === 'continuous' && prevShot.motion_direction && !shot.motion_direction) {
    segments.push(`延续空间视线方向平稳演进`)
  }

  return segments.filter(Boolean).join('；')
}

export interface ContextualPromptSynthesisOptions {
  assets?: CardAsset[]
  styleProfile?: { prompt?: string; referenceUrl?: string }
}

/**
 * 全章 `{ prev, curr, next }` 滑动窗口上下文提示词合成器：
 * 在分镜拆解完成后，基于前后相邻镜头、绑定角色设定卡/场景卡/道具卡与全局画风，
 * 为每一镜补齐高质量、无重复画风前缀的 `image_prompt` / `start_prompt`、差异化 `end_prompt` 与动态 `motion_prompt` / `videoPrompt`。
 */
export function synthesizeChapterContextualPrompts(
  configs: any[],
  options: ContextualPromptSynthesisOptions = {},
): any[] {
  if (!Array.isArray(configs) || !configs.length) return configs

  const assets = options.assets || []
  const stylePrompt = String(options.styleProfile?.prompt || '').trim() || DEFAULT_STYLE_PROMPT
  const assetById = new Map(assets.map(a => [String(a.id), a]))

  // 展平全章镜头索引以便构建 { prev, curr, next } 滑动窗口
  const flat: Array<{ sceneIdx: number; shotIdx: number; scene: any; shot: any }> = []
  configs.forEach((sc, sceneIdx) => {
    if (!sc || !Array.isArray(sc.shots)) return
    sc.shots.forEach((sh: any, shotIdx: number) => {
      if (sh && typeof sh === 'object') {
        flat.push({ sceneIdx, shotIdx, scene: sc, shot: sh })
      }
    })
  })

  for (let i = 0; i < flat.length; i++) {
    const { scene: sc, shot: sh, sceneIdx } = flat[i]!
    const prevEntry = i > 0 ? flat[i - 1]! : null
    const nextEntry = i < flat.length - 1 ? flat[i + 1]! : null
    const prevSameScene = prevEntry && prevEntry.sceneIdx === sceneIdx ? prevEntry.shot : null
    const nextSameScene = nextEntry && nextEntry.sceneIdx === sceneIdx ? nextEntry.shot : null

    const sceneRoleIds = (Array.isArray(sc.roles) ? sc.roles : [])
      .map((r: any) => Number(r?.id ?? r))
      .filter(Number.isSafeInteger)
    const shotRoleIds = (Array.isArray(sh.roles) ? sh.roles : [])
      .map((r: any) => Number(r?.id ?? r))
      .filter(Number.isSafeInteger)
    const mergedRoleIds = [...new Set([...sceneRoleIds, ...shotRoleIds])]

    const sceneAsset = assets.find(a => a.type === 'scene' && String(a.id) === String(sc.scene_id))
    const sceneCard = sceneAsset ? buildSceneCard(sceneAsset) : null
    const sceneSnapshot = sceneCard
      ? {
          scene_id: Number(sceneCard.id) || null,
          text: sceneCard.text,
          image_url: sceneCard.imageUrl,
        }
      : null

    const charRefsSnapshot = buildCharacterReferences(mergedRoleIds, assets)

    // 1. 静态首帧提示词（剥离重复画风前缀 + 补齐景别/机位/光影锚点）
    const rawImagePrompt = stripLeadingStylePrefix(
      String(sh.image_prompt || sh.start_prompt || sh.motion?.in || sh.content || '').trim(),
      stylePrompt,
    )
    const framingPrefix = [sh.shot_size, sh.camera_angle]
      .map((v: any) => String(v || '').trim())
      .filter(v => v && !rawImagePrompt.includes(v))
      .join('，')
    const lightingAnchor = String(sh.lighting || sh.continuity?.light_dir || '').trim()
    const cleanEnv = String(sc.environment || '').split('\n')[0]?.trim() || ''

    const enrichedImagePrompt = [
      framingPrefix,
      rawImagePrompt,
      lightingAnchor && !rawImagePrompt.includes(lightingAnchor) ? lightingAnchor : '',
      !rawImagePrompt && cleanEnv ? cleanEnv : '',
    ].filter(Boolean).join('，')

    sh.image_prompt = enrichedImagePrompt || rawImagePrompt
    sh.start_prompt = stripLeadingStylePrefix(
      String(sh.start_prompt || sh.image_prompt).trim(),
      stylePrompt,
    ) || sh.image_prompt

    // 2. 动态运动提示词（in -> path -> out）
    const synthesizedMotion = synthesizeMotionPromptDeterministic(sh, prevSameScene)
    sh.motion_prompt = String(sh.motion_prompt || synthesizedMotion).trim() || synthesizedMotion
    sh.videoPrompt = String(sh.videoPrompt || sh.motion_prompt).trim() || sh.motion_prompt

    // 3. 尾帧提示词（若为空或与首帧完全雷同，则自动由首帧 + 运动 + 下一镜衔接推导差异化终态）
    const rawEnd = stripLeadingStylePrefix(String(sh.end_prompt || '').trim(), stylePrompt)
    const nextHint = nextSameScene?.link?.anchor
      ? String(nextSameScene.link.anchor)
      : ''
    if (!rawEnd || rawEnd === sh.start_prompt || rawEnd === sh.image_prompt || rawEnd === String(sh.content || '').trim()) {
      sh.end_prompt = inferEndFramePromptDeterministic({
        startPrompt: sh.start_prompt,
        motionPrompt: sh.motion_prompt,
        motionOut: sh.motion?.out,
        cameraMovement: sh.camera_movement,
        shotSize: sh.shot_size,
        cameraAngle: sh.camera_angle,
        characterAction: sh.character_action || sh.subject_motion,
        keyPropAction: sh.key_prop_action,
        lighting: lightingAnchor,
        nextShotHint: nextHint,
      })
    } else {
      sh.end_prompt = rawEnd
    }

    // 4. 注入风格、场景、角色参考快照
    sh.style_prompt_snapshot = stylePrompt
    sh.scene_reference_snapshot = sceneSnapshot
    sh.character_references_snapshot = charRefsSnapshot

    if (!Array.isArray(sh.character_refs) || sh.character_refs.length === 0) {
      const derivedRefs = charRefsSnapshot.map(ref => {
        const asset = assetById.get(String(ref.role_id))
        return {
          role_id: String(ref.role_id),
          name: String(asset?.name || ref.role_id),
          description: ref.description,
          ...(ref.asset_url ? { image_url: ref.asset_url } : {}),
        }
      })
      if (derivedRefs.length > 0) sh.character_refs = derivedRefs
    }
  }

  return configs
}

export interface ContextualWindowPromptInput {
  mode: 'contextual' | 'end_frame'
  prevShot?: Record<string, any> | null
  currShot: Record<string, any>
  nextShot?: Record<string, any> | null
  sceneEnvironment?: string
  stylePrompt?: string
  assets?: CardAsset[]
  feedback?: string
}

/**
 * 组装 `{ prev, curr, next }` 滑动窗口推理或尾帧推理的 LLM 输入载荷（用于 `/pipeline/prompts/infer`）。
 */
export function buildContextualInferencePromptPayload(input: ContextualWindowPromptInput): string {
  const assets = input.assets || []
  const roleIds = (Array.isArray(input.currShot.roles) ? input.currShot.roles : [])
    .map((r: any) => r?.id ?? r)
  const characterCards = assets
    .filter(a => a.type === 'persona' && roleIds.some(id => String(id) === String(a.id)))
    .map(buildCharacterCard)
    .filter(Boolean)
  const sceneCard = assets
    .filter(a => a.type === 'scene')
    .map(buildSceneCard)
    .find(Boolean) || null
  const propCards = assets
    .filter(a => a.type === 'prop')
    .map(buildPropCard)
    .filter(Boolean)

  const summarize = (s?: Record<string, any> | null) => {
    if (!s) return null
    return {
      shot_size: s.shot_size || '',
      camera_angle: s.camera_angle || '',
      camera_movement: s.camera_movement || '',
      plot_description: s.plot_description || s.content || '',
      image_prompt: s.image_prompt || s.start_prompt || '',
      end_prompt: s.end_prompt || '',
      motion_prompt: s.motion_prompt || s.videoPrompt || s.subject_motion || '',
      dialogue: sanitizeDialogueList(s.dialogue || []).map((d: any) => `${d.speaker}：${d.text}`),
      world_state: s.world_state || '',
    }
  }

  return JSON.stringify({
    inference_mode: input.mode,
    scene_environment: input.sceneEnvironment || '',
    style_anchor: input.stylePrompt || DEFAULT_STYLE_PROMPT,
    character_cards: characterCards,
    scene_card: sceneCard,
    prop_cards: propCards,
    window: {
      prev: summarize(input.prevShot),
      curr: summarize(input.currShot),
      next: summarize(input.nextShot),
    },
    ...(input.feedback ? { validation_feedback: input.feedback } : {}),
  })
}

export interface InferredShotPrompts {
  image_prompt: string
  start_prompt: string
  end_prompt: string
  motion_prompt: string
  videoPrompt: string
  lighting?: string
  emotion?: string
}

/**
 * 校验并解析 `ShotPromptInferenceAgent` 的 JSON 输出。
 */
export function parseContextualInferenceResult(
  raw: string,
  mode: 'contextual' | 'end_frame',
  currShot: Record<string, any>,
  stylePrompt?: string,
): { ok: true; value: InferredShotPrompts } | { ok: false; error: string } {
  const parsed = safeJsonParse<Record<string, any>>(raw, 'object')
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ok: false, error: parsed.ok ? '返回数据不是 JSON 对象' : parsed.error }
  }

  const data = parsed.value
  const existingImage = stripLeadingStylePrefix(
    String(currShot.image_prompt || currShot.start_prompt || currShot.content || '').trim(),
    stylePrompt,
  )
  const existingMotion = String(currShot.motion_prompt || currShot.videoPrompt || currShot.subject_motion || '').trim()

  if (mode === 'end_frame') {
    const endRaw = stripLeadingStylePrefix(
      String(data.end_prompt || data.lastFramePrompt || data.tail_prompt || '').trim(),
      stylePrompt,
    )
    if (!endRaw) {
      return { ok: false, error: '缺少有效的尾帧提示词字段 end_prompt' }
    }
    if (existingImage && endRaw === existingImage) {
      return { ok: false, error: 'end_prompt 不得与首帧提示词完全相同，必须体现本镜动作演进后的终点画面状态' }
    }
    return {
      ok: true,
      value: {
        image_prompt: existingImage,
        start_prompt: existingImage,
        end_prompt: endRaw,
        motion_prompt: existingMotion,
        videoPrompt: existingMotion,
      },
    }
  }

  const imagePrompt = stripLeadingStylePrefix(
    String(data.image_prompt || data.firstFramePrompt || data.start_prompt || '').trim(),
    stylePrompt,
  )
  const motionPrompt = String(data.motion_prompt || data.videoPrompt || '').trim()
  let endPrompt = stripLeadingStylePrefix(
    String(data.end_prompt || data.lastFramePrompt || '').trim(),
    stylePrompt,
  )

  if (!imagePrompt) {
    return { ok: false, error: '缺少有效的静态首帧提示词字段 image_prompt' }
  }
  if (!motionPrompt) {
    return { ok: false, error: '缺少有效的动态运动提示词字段 motion_prompt' }
  }
  if (!endPrompt || endPrompt === imagePrompt) {
    endPrompt = inferEndFramePromptDeterministic({
      startPrompt: imagePrompt,
      motionPrompt,
      cameraMovement: currShot.camera_movement,
      shotSize: currShot.shot_size,
      cameraAngle: currShot.camera_angle,
      lighting: String(data.lighting || currShot.lighting || ''),
    })
  }

  return {
    ok: true,
    value: {
      image_prompt: imagePrompt,
      start_prompt: imagePrompt,
      end_prompt: endPrompt,
      motion_prompt: motionPrompt,
      videoPrompt: motionPrompt,
      ...(typeof data.lighting === 'string' && data.lighting.trim() ? { lighting: data.lighting.trim() } : {}),
      ...(typeof data.emotion === 'string' && data.emotion.trim() ? { emotion: data.emotion.trim() } : {}),
    },
  }
}
