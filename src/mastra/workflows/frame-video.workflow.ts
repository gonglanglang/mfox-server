import crypto from 'node:crypto'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { eq, inArray, and } from 'drizzle-orm'
import { db, schema } from '../../mysqlDb'
import { modifyPanelInTx } from '../../mysqlDb/panel'
import { generateTTS } from '../../tts/index'
import { LLMJSON } from '../../tools/index'
import { generateVideoByModel } from '../../videoTools/generate'
import { loadPanelPromptReferences } from '../../tools/storyboard-assets'
import { resolveSpeakerRoleId, normalizeShotLink, sanitizeDialogueList, resolveShotMotionPrompt } from '../../tools/storyboard-text'
import { inferShotVideoMode } from '../../pipeline/model-schema'
import { recordShotAssetVersion } from '../../pipeline/shot-assets-store'
import { resolveStoryboardPanel } from '../../tools/storyboard-panel'
import { normalizeAspectRatio } from '../../config/aspect-ratios'
import { uploadBufferToOSS } from '../../config/oss.config'
import { mergePanelAudioWithVideo } from '../../tools/video-compose'
import { inspectVideoQuality, saveQcRecordsToDb, type VideoQcReport } from '../../tools/video-qc'
import { sanitizeShotNegativePrompt, sanitizeVideoPromptAvoidClause } from './NovelScriptFlows/index'

/**
 * 尾帧措辞规范化（确定性兜底）。
 *
 * 首尾帧是以 reference_image（全模态参考模式）传给视频模型的——该模式下模型只会"参考"这两张图，
 * 不会插值到尾帧。prompt 里若写成"图2 为收尾画面 / 结尾画面"，模型就会在最后一秒硬切贴出该图
 * （表现为结尾突然闪一张静态照片）。Agent 指令已禁止这种写法，这里再做一次文本级兜底。
 */
export function normalizeTailFrameWording(prompt: string): string {
  return String(prompt || '')
    .replace(/作为收尾画面/g, '为下一帧参考')
    .replace(/作为结尾画面/g, '为下一帧参考')
    .replace(/收尾画面/g, '下一帧参考')
    .replace(/结尾画面/g, '下一帧参考')
    .replace(/最后一个画面/g, '下一帧参考')
    .replace(/最后一帧/g, '下一帧')
}

/**
 * MiniMax 情绪值白名单。
 * 分镜的 emotion 枚举里有 calm/fluent/whisper，但 whisper 只在 2.6 系列生效（当前用的 2.8 不支持），
 * 传了不仅无效还可能被供应商判为非法值；不在白名单内的一律不传（供应商会按文本自动匹配）。
 */
const MINIMAX_EMOTIONS = new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent'])
export function normalizeEmotion(emotion?: string): string {
  const value = String(emotion || '').trim().toLowerCase()
  if (!value) return ''
  // whisper（窃窃私语/耳边低语）在 MiniMax 2.8 不支持：映射到 calm（平静低语），
  // 保留"轻声克制"的情绪底色，而不是丢弃情绪让供应商按文本盲猜
  if (value === 'whisper') return 'calm'
  if (!MINIMAX_EMOTIONS.has(value)) return ''
  return value
}

/**
 * 逐句配音指纹：只要「文本 / 情绪 / 说话人归属 / 实际音色」有任一变化，这句的旧 mp3 就作废。
 *
 * 旧实现只看"有没有 audioUrl"，于是改台词、改音色、纠正台词归属之后重新生成视频，
 * 配音都会沿用旧文件（听起来"我的修改没生效"）。指纹把这几项绑在一起，任何一项变了都会重配。
 */
export function dialogueAudioKey(input: {
  speaker: string; roleId?: number; text: string; emotion: string; voiceId: string
}): string {
  return [
    String(input.speaker || '').trim(),
    input.roleId ?? '',
    String(input.text || '').trim(),
    String(input.emotion || '').trim(),
    String(input.voiceId || '').trim(),
  ].join('\u0001')
}

type VoiceRow = {
  id: number
  voice_id: string | null
  voice_name: string | null
  tags: unknown
}

function voiceTagsText(row: VoiceRow): string {
  const tags = Array.isArray(row.tags) ? row.tags.join(' ') : String(row.tags || '')
  return `${row.voice_name || ''} ${tags}`
}

/**
 * 当作品未显式配置旁白音色（works.narration_voice_id 为空）时，从音色库自动挑选最适合叙事旁白的音色。
 */
function pickDefaultNarrationVoice(allVoices: VoiceRow[]): VoiceRow | undefined {
  const valid = allVoices.filter(v => String(v.voice_id || '').trim())
  return (
    valid.find(v => /温暖叙事|叙事|旁白/.test(voiceTagsText(v)))
    || valid.find(v => /说书|故事/.test(voiceTagsText(v)))
    || valid.find(v => /成熟男性|温润/.test(voiceTagsText(v)))
    || valid[0]
  )
}

/**
 * 为未绑定音色的角色或未入 personas 主角色表的次要 NPC（如「管事」「执事」「守山弟子」「侍女」）匹配合适的独立音色，
 * 优先按显式 gender/age 字段匹配 voices.tags，其次按称谓关键词推断，避免盲目回退到主视角或固定男声。
 */
function pickNpcVoiceId(
  speaker: string,
  allVoices: VoiceRow[],
  usedProviderVoiceIds: Set<string>,
  profile?: { gender?: string | null; age?: string | null },
): string {
  const valid = allVoices.filter(v => String(v.voice_id || '').trim())
  if (!valid.length) return ''
  const unused = valid.filter(v => !usedProviderVoiceIds.has(String(v.voice_id || '').trim()))
  const pool = unused.length ? unused : valid
  const name = String(speaker || '').trim()
  const rawGender = String(profile?.gender || '').trim().toLowerCase()
  const rawAge = String(profile?.age || '').trim()

  const isFemale = rawGender === 'female' || rawGender === '女' || rawGender === '女性'
    || (!rawGender && /侍女|丫鬟|妇人|女子|少女|婆婆|老妇|大娘|师姐|师妹|夫人|娘子|小姐|姑娘|仙子|女修|师太|圣女|公主|娘娘|母亲|姨|婶|姑|嫂|女/.test(name))
  const isMale = rawGender === 'male' || rawGender === '男' || rawGender === '男性'

  if (isFemale && !isMale) {
    if (/婆婆|老妇|大娘|师太|太后|老妪/.test(name) || /老|中年/.test(rawAge)) {
      const matureFem = pool.find(v => /女性|女/.test(voiceTagsText(v)) && /中年|老年|成熟|御姐/.test(voiceTagsText(v)))
      if (matureFem?.voice_id) return matureFem.voice_id
    }
    const fem = pool.find(v => /女性|女/.test(voiceTagsText(v)))
    if (fem?.voice_id) return fem.voice_id
  }
  if (/管事|执事|长老|掌柜|大叔|老者|老汉|家丁|护卫|掌门|堂主|教习/.test(name) || /中年|老年|老/.test(rawAge)) {
    const elderMale = pool.find(v => /男性|男/.test(voiceTagsText(v)) && /中年|老年|大叔|成熟/.test(voiceTagsText(v)))
    if (elderMale?.voice_id) return elderMale.voice_id
  }
  if (isMale) {
    const male = pool.find(v => /男性|男/.test(voiceTagsText(v)))
    if (male?.voice_id) return male.voice_id
  }
  const anyMale = pool.find(v => /男性|男/.test(voiceTagsText(v)))
  return String((anyMale || pool[0])?.voice_id || '')
}

const segmentItemSchema = z.object({
  type: z.enum(['narration', 'dialogue']).describe('场景类型，旁白或对白'),
  text: z.string().describe('台词或旁白正文'),
  emotion: z.string().optional().describe('情绪'),
  tone: z.string().optional().describe('语气'),
  role_id: z.number().int().optional().describe('角色ID'),
  roleName: z.string().optional().describe('说话人名称'),
  isInnerOs: z.boolean().optional().describe('是否为内心OS'),
  audioUrl: z.string().optional().describe('语音 URL'),
  audioDuration: z.number().optional().describe('语音时长（秒）'),
})

// ============================================
// Step 1: 为每个 segment（旁白/对白）生成 TTS 语音（并发）
// ============================================
const FrameGeneratePanelTTS = createStep({
  id: 'generate-panel-tts',
  inputSchema: z.object({
    workId: z.number().describe('作品 ID'),
    userId: z.number().describe('用户 ID'),
    chapterId: z.number().describe('章节 ID'),
    narrationVoiceId: z.number().int().nullable().optional().describe('旁白音色 ID'),
    model: z.string().min(1).describe('视频模型 ID'),
    quality: z.string().optional().describe('视频质量档位'),
    resolution: z.string().optional().describe('视频分辨率'),
    panelIdx: z.number().int().describe('面板索引'),
  }),
  outputSchema: z.object({
    workId: z.number().describe('作品 ID'),
    userId: z.number().describe('用户 ID'),
    segments: z.array(segmentItemSchema),
    characterSheet: z.array(z.object({
      name: z.string().describe('角色名称'),
      url: z.string().describe('角色图片 URL'),
    })),
    chapterId: z.number().int().describe('章节 ID'),
    model: z.string().min(1).describe('视频模型 ID'),
    quality: z.string().optional().describe('视频质量档位'),
    resolution: z.string().optional().describe('视频分辨率'),
    panelIdx: z.number().int().describe('面板索引'),
  }),
  execute: async ({ inputData }) => {
    const { chapterId, panelIdx, narrationVoiceId, workId, userId } = inputData

    // 从数据库获取分镜配置
    const panel = await modifyPanelInTx(chapterId, panelIdx, async (panel) => {
      panel.panelStatus = 'generating'
    }) as any

    // 读取全部可用音色（用于角色音色映射、旁白兜底与未入表 NPC 音色分配）
    const allVoices: VoiceRow[] = await db.select({
      id: schema.voices.id,
      voice_id: schema.voices.voice_id,
      voice_name: schema.voices.voice_name,
      tags: schema.voices.tags,
    }).from(schema.voices)
    const providerVoiceMap = new Map(
      allVoices.map(r => [r.id, String(r.voice_id || '').trim()]),
    )

    // 解析旁白音色：入参 narrationVoiceId → works.narration_voice_id → 默认叙事音色兜底
    let effectiveNarrationVoiceDbId = narrationVoiceId ?? null
    if (effectiveNarrationVoiceDbId == null && workId) {
      const [workRow] = await db
        .select({ narrationVoiceId: schema.works.narration_voice_id })
        .from(schema.works)
        .where(eq(schema.works.id, workId))
        .limit(1)
      effectiveNarrationVoiceDbId = workRow?.narrationVoiceId ?? null
    }
    const configuredNarrationVoice = effectiveNarrationVoiceDbId != null
      ? allVoices.find(v => v.id === effectiveNarrationVoiceDbId && String(v.voice_id || '').trim())
      : undefined
    const fallbackNarrationVoice = configuredNarrationVoice || pickDefaultNarrationVoice(allVoices)
    const narrationProviderVoiceId = String(fallbackNarrationVoice?.voice_id || '').trim()

    // 查询当前作品下的全部角色素材（即使某角色漏填进 panel.roles，也能按 speaker 姓名准确匹配到其音色）
    // 自动剔除“无”、“（无）”、“无台词”等空占位符，严禁为无台词镜头生成“无”字配音
    const dialogueRaw: any[] = sanitizeDialogueList(Array.isArray(panel.dialogue) ? panel.dialogue : [])
    const panelRoleIds = [...new Set(((panel.roles as { id: unknown }[]) || [])
      .map(role => Number(role?.id)).filter(Number.isSafeInteger))] as number[]
    const allWorkPersonas = await db.select({
      id: schema.personas.id,
      voice_id: schema.personas.voice_id,
      name: schema.personas.name,
      gender: schema.personas.gender,
      age: schema.personas.age,
      personasImages: schema.personas.images,
      currentPersonaId: schema.personas.cur_image_id,
    })
      .from(schema.personas)
      .where(and(
        eq(schema.personas.source_type, 'persona'),
        eq(schema.personas.work_id, workId),
        eq(schema.personas.user_id, userId),
      ))

    const panelPersonaSet = new Set(panelRoleIds)
    const personaRows = allWorkPersonas.filter(r => panelPersonaSet.has(r.id))
    const characterSheet = personaRows.map(r => {
      const { url } = (Array.isArray(r.personasImages) ? r.personasImages as any[] : [])
        .find(i => i.id === r.currentPersonaId) || {}
      return {
        name: r.name,
        url: url || '',
      }
    })
    const personaVoiceIdMap = new Map(allWorkPersonas.map(r => [r.id, r.voice_id]))
    const personaNameMap = new Map(allWorkPersonas.map(r => [r.id, r.name]))
    const personaProfileMap = new Map(allWorkPersonas.map(r => [r.id, { gender: r.gender, age: r.age }]))

    // 已在场角色的供应商音色集合（用于为 NPC 挑选不撞车的音色）
    const activeProviderVoices = new Set<string>(
      allWorkPersonas
        .map(r => (r.voice_id == null ? '' : providerVoiceMap.get(r.voice_id) || ''))
        .filter(Boolean),
    )
    if (narrationProviderVoiceId) activeProviderVoices.add(narrationProviderVoiceId)

    // 角色 → 供应商音色 对照（"多个角色共用同一音色"的告警要用）
    const roleVoicePairs = personaRows
      .map(r => [r.id, String(r.voice_id == null ? '' : providerVoiceMap.get(r.voice_id) || '')] as const)
      .sort((a, b) => a[0] - b[0])

    // ── segments：由 dialogue 现组装 ──
    const correctedRoleIds: (number | undefined)[] = []
    const segments: {
      type: 'narration' | 'dialogue'; role_id?: number; text: string; emotion?: string; tone?: string
      audioUrl?: string; audioDuration?: number; audioKey: string; voiceId: string; roleName: string
      isInnerOs: boolean; voiceFallback: boolean; needsTts: boolean
    }[] = dialogueRaw.map((line: any, index: number) => {
      const stated = line?.id === '' || line?.id == null ? undefined : Number(line.id)
      const speaker = String(line?.speaker || '').trim()
      const isNarration = speaker === '旁白' || /^旁白[（(]/.test(speaker)
      const isInnerOs = /[（(]内心\s*OS[）)]/i.test(speaker)

      // 关键修复：
      // 1. 旁白（speaker === '旁白'）绝不回退到 stated（主视角角色 ID），否则旁白会被当成主角台词并用主角少年音配音；
      // 2. 非旁白先按 speaker 名称在全作品角色表中精确查找（fallback 传空串 ''），
      //    若 speaker 是未入表的次要 NPC（如「管事」），绝不回退到 stated（主角 ID），而是为其分配独立 NPC 音色。
      let role: number | undefined
      if (isNarration) {
        role = undefined
      } else if (speaker) {
        const matched = resolveSpeakerRoleId(speaker, '', allWorkPersonas)
        role = matched && /^\d+$/.test(matched) ? Number(matched) : undefined
      } else if (Number.isSafeInteger(stated)) {
        role = stated
      }
      correctedRoleIds[index] = role

      const type: 'narration' | 'dialogue' = isNarration ? 'narration' : 'dialogue'
      const text = String(line?.text || '')
      const emotion = String(line?.emotion || '')
      const tone = String(line?.tone || '')
      const cleanSpeakerName = speaker.replace(/[（(]内心\s*OS[）)]/gi, '').trim()
      const roleName = isNarration
        ? '旁白'
        : role != null
          ? (personaNameMap.get(role) || cleanSpeakerName || `#${role}`)
          : (cleanSpeakerName || '角色')

      // 音色选择：
      // - 旁白：使用旁白音色（narrationProviderVoiceId）
      // - 已入表角色：优先使用该角色的 voice_id；若未绑定，则按其 gender/age 特征匹配独立音色
      // - 未入表 NPC（如「管事」）：按称谓/性别/年龄特征从音色库自动挑选独立音色
      const personaVoiceId = role == null ? undefined : personaVoiceIdMap.get(role)
      const roleProviderVoiceId = personaVoiceId == null ? '' : (providerVoiceMap.get(personaVoiceId) || '')
      const npcProviderVoiceId = (!isNarration && !roleProviderVoiceId)
        ? pickNpcVoiceId(roleName, allVoices, activeProviderVoices, role == null ? undefined : personaProfileMap.get(role))
        : ''
      const voiceId = isNarration
        ? narrationProviderVoiceId
        : (roleProviderVoiceId || npcProviderVoiceId || narrationProviderVoiceId)

      const audioKey = dialogueAudioKey({ speaker: roleName, roleId: role, text, emotion, voiceId })
      const audioUrl = String(line?.audioUrl || '')
      const cachedDuration = Number(line?.audioDuration)
      return {
        type,
        role_id: role,
        text,
        emotion,
        tone,
        audioUrl,
        audioDuration: Number.isFinite(cachedDuration) && cachedDuration > 0 ? cachedDuration : undefined,
        audioKey,
        voiceId,
        roleName,
        isInnerOs,
        voiceFallback: role != null && !roleProviderVoiceId && Boolean(narrationProviderVoiceId),
        needsTts: Boolean(text.trim()) && (!audioUrl || String(line?.audioKey || '') !== audioKey),
      }
    })
    const repatchCount = segments.filter(segment => segment.needsTts && segment.audioUrl).length
    if (repatchCount) console.log(`[TTS] ${repatchCount} 句台词的文本/情绪/归属/音色有变化，将重新配音`)

    // 逐跳打印音色解析链路：明确区分"本镜有台词的角色"与"在场但无台词"
    const speakingRoleIds = new Set(segments
      .filter(segment => segment.type === 'dialogue' && segment.role_id)
      .map(segment => segment.role_id!))
    const describeVoiceChain = (row: typeof allWorkPersonas[number]) =>
      `${row.name}(personas.id=${row.id}, personas.voice_id=${row.voice_id ?? '未设置'}`
      + `, provider=${row.voice_id == null ? '-' : (providerVoiceMap.get(row.voice_id) || '未找到对应配音')})`
    if (personaRows.length) {
      const speaking = allWorkPersonas.filter(row => speakingRoleIds.has(row.id))
      const silent = personaRows.filter(row => !speakingRoleIds.has(row.id))
      console.log('[TTS] 本镜有台词的角色：' + (speaking.map(describeVoiceChain).join('；') || '（无）'))
      if (silent.length) {
        console.log('[TTS] 在场但本镜无台词（不参与配音）：' + silent.map(row => row.name).join('、'))
      }
    }

    // 多个角色共用同一个供应商音色时明确告警
    const voiceOwners = new Map<string, string[]>()
    for (const [roleId, providerVoiceId] of roleVoicePairs) {
      if (!providerVoiceId) continue
      const names = voiceOwners.get(providerVoiceId) || []
      names.push(personaNameMap.get(roleId) || `#${roleId}`)
      voiceOwners.set(providerVoiceId, names)
    }
    for (const [providerVoiceId, names] of voiceOwners) {
      if (names.length > 1) {
        console.warn(`[TTS] 以下角色使用了同一个供应商音色「${providerVoiceId}」：${names.join('、')}`
          + '（请检查这些角色在「故事素材」里选择的配音，以及配音素材的 voice_id 是否重复）')
      }
    }

    // 并发为需要重配的句子生成 TTS
    const ttsStats = { attempted: 0, succeeded: 0, errors: [] as string[] }
    const tasks = segments
      .filter(seg => seg.needsTts)
      .map(async (seg) => {
        if (!seg.voiceId) {
          ttsStats.errors.push(`${seg.roleName} 没有可用音色（未选配音 / 配音缺少供应商 voice_id），`
            + `「${String(seg.text).slice(0, 12)}…」没有配音`)
          return
        }
        if (seg.voiceFallback) {
          console.warn(`[TTS] ${seg.roleName} 未配置可用音色，回退默认音色 ${seg.voiceId}`)
        }
        ttsStats.attempted++
        console.log(`[TTS] ${seg.roleName} 使用音色 ${seg.voiceId}（语气：${seg.tone || '默认'}，句子：${String(seg.text).slice(0, 16)}…）`)
        const r = await generateTTS({
          model: 'speech-2.8-hd',
          text: seg.text,
          emotion: normalizeEmotion(seg.emotion),
          tone: seg.tone,
          voice_id: seg.voiceId,
        })
        if (r.success) {
          seg.audioUrl = r.voiceUrl
          seg.audioDuration = r.duration > 0
            ? r.duration
            : Math.max(1.5, Number((seg.text.length / 4.2).toFixed(2)))
          ttsStats.succeeded++
        } else {
          ttsStats.errors.push(`${seg.roleName}「${String(seg.text).slice(0, 12)}…」: ${r.error}`)
        }
      })

    await Promise.all(tasks)

    // 配音整体失败时不再静默：成品必然无声，直接失败（上层会标记错误并退款）
    if (ttsStats.attempted > 0 && ttsStats.succeeded === 0) {
      throw new Error(`全部配音生成失败，已中止：${ttsStats.errors.slice(0, 3).join('；')}`)
    }
    if (ttsStats.errors.length) {
      console.warn(`部分配音失败（${ttsStats.errors.length}/${ttsStats.attempted}）：${ttsStats.errors.slice(0, 3).join('；')}`)
    }

    // 计算本镜全部台词/旁白所需的最小视频时长，避免长台词在短视频末尾被截断
    const totalSpeechSec = segments.reduce((sum, seg) => {
      if (!seg.text.trim()) return sum
      const dur = seg.audioDuration && seg.audioDuration > 0
        ? seg.audioDuration
        : Math.max(1.5, Number((seg.text.length / 4.2).toFixed(2)))
      return sum + dur
    }, 0) + Math.max(0, segments.length - 1) * 0.25

    // 把 TTS 结果与校正后的角色归属、镜头时长写回数据库（同时永久清理掉历史遗留的“无”占位台词）
    await modifyPanelInTx(chapterId, panelIdx, async (p) => {
      const dialogue = sanitizeDialogueList(Array.isArray(p.dialogue) ? p.dialogue : [])
      dialogue.forEach((line: any, index: number) => {
        const segment = segments[index]
        const corrected = correctedRoleIds[index]
        // 旁白或未入表 NPC 清空被主视角污染的 id；已入表角色写回准确 id
        if (corrected === undefined) {
          if (line?.speaker === '旁白' || /^旁白[（(]/.test(String(line?.speaker || '').trim())) {
            line.id = ''
          }
        } else if (String(line?.id ?? '') !== String(corrected)) {
          line.id = corrected
        }
        if (!segment?.audioUrl) return
        line.audioUrl = segment.audioUrl
        line.audioKey = segment.audioKey
        if (segment.audioDuration) line.audioDuration = segment.audioDuration
      })
      p.dialogue = dialogue
      if (segments.length > 0 && totalSpeechSec > 0) {
        const minDur = Math.min(15, Math.max(4, Math.ceil(totalSpeechSec + 0.3)))
        if ((Number(p.durShort) || 5) < minDur) {
          console.log(`[TTS] 本镜配音总时长约 ${totalSpeechSec.toFixed(1)}s，自动将镜头时长从 ${p.durShort || 5}s 调整为 ${minDur}s`)
          p.durShort = minDur
        }
      }
      return p
    }) as any

    return {
      segments,
      chapterId,
      panelIdx,
      characterSheet,
      model: inputData.model,
      quality: inputData.quality,
      workId,
      userId,
      resolution: inputData.resolution,
    }
  },
})

// ============================================
// Step 2: 生成视频提示词（AI 生成 prompt，不生成视频）
// ============================================
const generateVideoPrompt = createStep({
  id: 'generate-video-prompt',
  inputSchema: z.object({
    workId: z.number().describe('作品 ID'),
    userId: z.number().describe('用户 ID'),
    chapterId: z.number().describe('章节 ID'),
    model: z.string().min(1).describe('视频模型 ID'),
    quality: z.string().optional().describe('视频质量档位'),
    resolution: z.string().optional().describe('视频分辨率'),
    panelIdx: z.number().int().describe('当前分镜序号，从0开始'),
    segments: z.array(segmentItemSchema).describe('分镜中的配音片段'),
    characterSheet: z.array(z.object({
      name: z.string().describe('角色名称'),
      url: z.string().describe('角色图片 URL'),
    })).describe('角色列表'),
  }),
  outputSchema: z.object({
    content: z.object({
      prompt: z.string().describe('视频 prompt'),
      media: z.array(z.object({
        type: z.enum(['reference_image', 'reference_video', 'reference_audio']).describe('媒体类型'),
        url: z.string().describe('媒体 URL'),
      })),
    }),
    segments: z.array(segmentItemSchema).optional().describe('透传给第三步合成配音'),
    chapterId: z.number().describe('当前章节ID'),
    workId: z.number().optional().describe('作品 ID'),
    userId: z.number().optional().describe('用户 ID'),
    model: z.string().min(1).describe('视频模型 ID'),
    quality: z.string().optional().describe('视频质量档位'),
    resolution: z.string().optional().describe('视频分辨率'),
    panelIdx: z.number().int().describe('当前分镜序号，从0开始'),
  }),
  execute: async ({ inputData, mastra }) => {
    const { chapterId, panelIdx, segments, characterSheet, workId, userId } = inputData

    // 从数据库读取分镜配置与作品级帧模式配置
    let prevVideoUrl = ''
    let workFrameMode = 'single'
    if (workId) {
      const [work] = await db.select({
        usePrevVideo: schema.works.use_prev_video,
        frameMode: schema.works.frame_mode,
      }).from(schema.works).where(eq(schema.works.id, workId)).limit(1)
      if (work?.frameMode) workFrameMode = String(work.frameMode)
      if (panelIdx > 0 && Number(work?.usePrevVideo) === 1) {
        const [chRow] = await db.select({ configs: schema.chapters.content_configs }).from(schema.chapters).where(eq(schema.chapters.id, chapterId)).limit(1)
        const cfgList = Array.isArray(chRow?.configs) ? chRow.configs as any[] : []
        const curTarget = resolveStoryboardPanel(cfgList, panelIdx)
        const prevTarget = resolveStoryboardPanel(cfgList, panelIdx - 1)
        if (prevTarget && prevTarget.sceneIdx === curTarget?.sceneIdx && typeof prevTarget.panel?.finalVideoUrl === 'string' && prevTarget.panel.finalVideoUrl.trim()) {
          prevVideoUrl = prevTarget.panel.finalVideoUrl.trim()
        }
      }
    }
    const panel = await modifyPanelInTx(chapterId, panelIdx, async (p) => p) as any

    // 1. AI 生成视频 prompt
    const agent: any = mastra?.getAgent('VideoPromptGeneratorOmnimodalAgent')
    if (!agent) throw new Error('Agent VideoPromptGeneratorOmnimodalAgent 未注册')
    const {
      props: promptProps,
      scene: promptScene,
      sceneImage,
    } = await loadPanelPromptReferences({
      workId,
      chapterId,
      userId,
      roles: panel.roles,
      sceneId: panel.scene_id ?? panel.sceneId,
      propIds: panel.prop_ids,
    })

    // 关键优化：
    // 1. resolveStoryboardPanel 拼出的 panel.environment 含 "\n" + shot.content，只取首行纯场景环境描述；
    // 2. 支持市场主流单帧 I2V 模式（frame_mode = 'single'）：当仅使用首帧驱动时，不传入尾帧（避免首尾两张 AI 图几何错位导致视频扭曲/动作重做）；
    // 3. 当首帧已生成（firstFrameUrl 存在）时，首帧中已完整包含场景与角色，不再重复塞入空场景图（sceneImage）与四视图角色设定表（characterSheet）；
    // 4. 配音统一在 Step 3 由 FFmpeg 将高清 MiniMax TTS 音频与视频环境音混音合成。
    const cleanEnvironment = String(panel.environment || '').split('\n')[0]?.trim() || ''
    const effectiveFrameMode = String(panel.frame_mode || workFrameMode || 'single')
    const effectiveGenMode = inferShotVideoMode(panel, effectiveFrameMode as any)
    const effectiveFirstFrameUrl = effectiveGenMode === 'text2video'
      ? ''
      : String(panel.firstFrameUrl || panel.reference_frame_url || '')
    const effectiveLastFrameUrl = (effectiveGenMode === 'frames2video' || (effectiveFrameMode === 'dual' && !panel.gen_mode))
      ? String(panel.lastFrameUrl || '')
      : ''
    const hasPrimaryKeyframe = Boolean(effectiveFirstFrameUrl)
    const hasTtsSegments = (segments || []).some(s => Boolean(s.audioUrl || s.text?.trim()))

    // 若本镜有画内角色开口对白（非旁白、非内心OS）：
    // 1. 必须剔除 motion.in 中"双唇紧闭/未开口"等只针对静态首帧的描述，改为从镜头起始即刻自然张合嘴唇做说话口型，
    //    防止视频前半段人物闭嘴、后半段才张嘴，导致与从 0.15s 起播的 MiniMax TTS 配音时间轴错位；
    // 2. 动作描述改为"无声口型动作"，并在 sound_effect 与 negative_prompt 中严禁视频模型自己生成人声台词，
    //    防止视频模型胡乱脑补台词（如"王管事，求你了"）与 TTS 配音叠音打架。
    const onScreenSpeakers = (segments || [])
      .filter(s => s.type === 'dialogue' && !s.isInnerOs && s.text.trim())
      .map(s => s.roleName || '人物')
    const stripClosedMouth = (text: string) =>
      String(text || '')
        .replace(/，?(?:此刻)?(?:双唇紧闭|唇紧闭|紧闭双唇|嘴唇紧闭|闭唇|尚未开口|未开口|喉结未动|喉结未滚动)/g, '')
        .replace(/(?:压着嗓子|压嗓|大声|低声|冷声)?开口(?:说话)?/g, '双唇自然微张持续做说话口型')
        .trim()

    const rawMotionPrompt = resolveShotMotionPrompt(panel)
    const baseMotion = onScreenSpeakers.length
      ? stripClosedMouth(rawMotionPrompt)
      : rawMotionPrompt
    const enrichedMotion = onScreenSpeakers.length && baseMotion
      ? `${baseMotion.replace(/[。.]$/, '')}，${onScreenSpeakers[0]}从镜头起始双唇即自然微张持续做说话口型（仅视觉口型动作，不生成人声语音）。`
      : baseMotion

    const normalizedMotion = panel.motion && typeof panel.motion === 'object'
      ? (onScreenSpeakers.length
        ? {
          ...panel.motion,
          in: `${stripClosedMouth(String(panel.motion.in || '')).replace(/[。.]$/, '')}，${onScreenSpeakers[0]}双唇微张即刻开始做说话口型。`,
          path: `${stripClosedMouth(String(panel.motion.path || '')).replace(/[。.]$/, '')}，全程嘴唇随话语节奏持续自然开合（仅视觉口型，无对白人声）。`,
        }
        : panel.motion)
      : undefined

    const cleanNegativePrompt = sanitizeShotNegativePrompt(
      panel.negative_prompt,
      hasTtsSegments ? '人声对白；说话声；旁白声' : '',
    )
    const effectiveSoundEffect = hasTtsSegments
      ? `${String(panel.sound_effect || '环境音').trim()}（仅保留纯环境音效，禁止生成任何人声对白或说话声）`
      : (panel.sound_effect || '')

    const promptInput = JSON.stringify({
      firstFrameUrl: effectiveFirstFrameUrl,
      lastFrameUrl: effectiveLastFrameUrl,
      frame_mode: effectiveFrameMode,
      gen_mode: effectiveGenMode,
      ...(prevVideoUrl ? { prevVideoUrl } : {}),
      shot_size: panel.shot_size || '',
      camera_angle: panel.camera_angle || '',
      camera_movement: panel.camera_movement || '',
      subject_motion: enrichedMotion,
      motion_prompt: enrichedMotion,
      ...(normalizedMotion ? { motion: normalizedMotion } : {}),
      ...(panel.link ? { link: normalizeShotLink(panel) } : {}),
      ...(panel.world_state ? { world_state: panel.world_state } : {}),
      ...(panel.prev_shot_summary ? { prev_shot_summary: panel.prev_shot_summary } : {}),
      key_prop_action: panel.key_prop_action || '',
      sound_effect: effectiveSoundEffect,
      environment: cleanEnvironment,
      negative_prompt: cleanNegativePrompt,
      scene: cleanEnvironment ? '' : promptScene,
      sceneImage: hasPrimaryKeyframe ? '' : sceneImage,
      segments: [],
      characterSheet: hasPrimaryKeyframe ? [] : characterSheet,
      props: promptProps || [],
    })

    console.log('视频 prompt 输入:', promptInput)

    const result = await agent.generate(promptInput)
    const text = result.text || ''
    if (!text) throw new Error('视频 prompt 生成返回为空')

    const content: any = LLMJSON(text)
    // 尾帧措辞与负面避免清单确定性清洗
    if (content && typeof content === 'object' && typeof content.prompt === 'string') {
      content.prompt = sanitizeVideoPromptAvoidClause(normalizeTailFrameWording(content.prompt))
      if (prevVideoUrl && Array.isArray(content.media) && !content.media.some((m: any) => m?.type === 'reference_video' && m?.url === prevVideoUrl)) {
        content.media.push({ type: 'reference_video', url: prevVideoUrl })
      }
    }
    console.log('视频 prompt 生成结果:', content)
    // 存储 content 到分镜对象
    await modifyPanelInTx(chapterId, panelIdx, async (p) => {
      p.videoContent = content
      p.videoPrompt = content?.prompt || ''
      p.panelStatus = 'generating'
    }) as any

    return {
      content,
      segments,
      chapterId,
      panelIdx,
      workId,
      userId,
      model: inputData.model,
      quality: inputData.quality || '',
      resolution: inputData.resolution || '',
    }
  },
})

// ============================================
// Step 3: 生成视频并合成高清 TTS 配音（最终分镜视频）
// ============================================
const generateVideoAndMerge = createStep({
  id: 'generate-video-and-merge',
  inputSchema: z.object({
    content: z.object({
      prompt: z.string().describe('视频 prompt'),
      media: z.array(z.object({
        type: z.enum(['reference_image', 'reference_video', 'reference_audio']).describe('媒体类型'),
        url: z.string().describe('媒体 URL'),
      })),
    }),
    segments: z.array(segmentItemSchema).optional().describe('分镜配音片段'),
    chapterId: z.number().describe('当前章节ID'),
    workId: z.number().optional().describe('作品 ID'),
    userId: z.number().optional().describe('用户 ID'),
    model: z.string().min(1).describe('视频模型 ID'),
    quality: z.string().optional().describe('视频质量档位'),
    resolution: z.string().optional().describe('视频分辨率'),
    panelIdx: z.number().int().describe('当前分镜序号，从0开始'),
  }),
  outputSchema: z.object({
    finalVideoUrl: z.string().describe('最终带声音的视频 URL'),
  }),
  execute: async ({ inputData }) => {
    const { chapterId, panelIdx, content } = inputData
    if (!content || !content.prompt) {
      return { finalVideoUrl: '' }
    }

    // 从数据库读取分镜配置（拿时长）
    const [work] = inputData.workId
      ? await db.select({ aspectRatio: schema.works.aspect_ratio }).from(schema.works).where(eq(schema.works.id, inputData.workId)).limit(1)
      : []
    const ratio = normalizeAspectRatio(work?.aspectRatio) || undefined
    const panel = await modifyPanelInTx(chapterId, panelIdx, async (p) => p) as any
    console.log('分镜配置:', panel)
    // 1. 调用视频生成适配器 + 2. 合成 TTS 配音 + 3. 成片自动质检与未达标自动回退重生成（需求 3.2 / 6 P3）
    const resolvedGenMode = inferShotVideoMode(panel)
    const params = {
      content,
      mode: resolvedGenMode,
      chapterId,
      panelIdx,
      duration: Math.max(2, Math.min(15, Number(panel.durShort) || 5)),
      ratio,
      model: inputData.model,
      quality: inputData.quality,
      resolution: inputData.resolution,
    }
    const cleanPanelDialogue = sanitizeDialogueList(Array.isArray(panel.dialogue) ? panel.dialogue : [])
    const dialogueFallbackUrls = cleanPanelDialogue
      .map((d: any) => String(d?.audioUrl || '').trim()).filter(Boolean)
    const segmentAudioUrls = (inputData.segments || [])
      .map(s => String(s?.audioUrl || '').trim())
      .filter(Boolean)
    const audioUrls = segmentAudioUrls.length ? segmentAudioUrls : dialogueFallbackUrls

    let videoUrl = ''
    let lastQcReport: VideoQcReport | null = null
    const maxQcAttempts = 2

    for (let qcAttempt = 1; qcAttempt <= maxQcAttempts; qcAttempt++) {
      console.log(`提交视频生成参数 (第 ${qcAttempt}/${maxQcAttempts} 次):`, params)
      const result = await generateVideoByModel(params)
      console.log('视频生成结果:', result)
      videoUrl = result?.videoUrl || ''
      if (!videoUrl) {
        if (qcAttempt < maxQcAttempts) {
          console.warn(`[自动质检回退] 分镜 ${panelIdx} 第 ${qcAttempt} 次生成未返回 URL，触发回退重生成...`)
          await modifyPanelInTx(chapterId, panelIdx, async (p) => {
            p.panelStatus = 'regenerating'
            p.continuity_status = 'regenerating'
            return p
          }) as any
          continue
        }
        await modifyPanelInTx(chapterId, panelIdx, async (p) => {
          p.panelStatus = 'error'
          p.continuity_status = 'qc_failed'
          return p
        }) as any
        throw new Error(`${result.error || '视频生成失败'}${result.taskId ? `（供应商任务 ID: ${result.taskId}）` : ''}`)
      }

      let muxedBuffer: Buffer | undefined
      let speechDurationSec = 0
      if (audioUrls.length > 0) {
        try {
          console.log(`[TTS混音] 分镜 ${panelIdx} 正在合成 ${audioUrls.length} 段高清 TTS 语音与视频环境音...`)
          const muxed = await mergePanelAudioWithVideo({
            videoUrl,
            audioUrls,
            replaceOriginalAudio: false,
          })
          muxedBuffer = muxed.buffer
          speechDurationSec = muxed.speechDurationSec
          const muxedKey = `videos/frames/${crypto.randomUUID()}.mp4`
          videoUrl = await uploadBufferToOSS(muxedKey, muxed.buffer, 'video/mp4')
          console.log(`[TTS混音] 分镜 ${panelIdx} 音视频合成完成: ${videoUrl}（总时长 ${muxed.durationSec.toFixed(2)}s，配音时长 ${muxed.speechDurationSec.toFixed(2)}s）`)
        } catch (muxErr: any) {
          console.warn(`[TTS混音] 分镜 ${panelIdx} 混音失败，保留原视频: ${muxErr?.message || muxErr}`)
        }
      }

      try {
        const renderId = `panel-${chapterId}-${panelIdx}-a${qcAttempt}-${Date.now()}`
        const qcReport = await inspectVideoQuality({
          renderId,
          chapterId,
          panelIdx,
          videoBuffer: muxedBuffer,
          videoUrl: muxedBuffer ? undefined : videoUrl,
          expectedSpeechDurationSec: speechDurationSec,
          expectedShotDurationSec: params.duration,
          dialogue: cleanPanelDialogue,
          shot: panel,
          allowBlackFade: panel.transition_out === '黑场' || panel.transition === '黑场',
        })
        lastQcReport = qcReport
        await saveQcRecordsToDb(qcReport.records).catch(err =>
          console.warn(`[QC] 写入 qc_record 失败: ${err?.message || err}`),
        )
        if (qcReport.shouldRegenerate && qcAttempt < maxQcAttempts) {
          const failReasons = qcReport.records.filter(r => r.regenerate_flag === 1).map(r => r.detail).join('；')
          console.warn(`[自动质检回退] 分镜 ${panelIdx} 质检未达标（得分 ${qcReport.overallScore}：${failReasons}），状态置为 regenerating 并自动回退重生成...`)
          await modifyPanelInTx(chapterId, panelIdx, async (p) => {
            p.panelStatus = 'regenerating'
            p.continuity_status = 'regenerating'
            p.qcReport = { score: qcReport.overallScore, passed: false, items: qcReport.records }
            return p
          }) as any
          continue
        }
      } catch (qcErr: any) {
        console.warn(`[QC] 分镜 ${panelIdx} 自动质检跳过: ${qcErr?.message || qcErr}`)
      }
      break
    }

    console.log(`最终视频: ${videoUrl}`)

    // 存储最终视频 URL 与质检报告，标记完成
    let resolvedSceneIdx = 0
    let resolvedShotIdx = panelIdx
    await modifyPanelInTx(chapterId, panelIdx, async (p, _configs, target) => {
      if (target?.sceneIdx !== undefined) {
        resolvedSceneIdx = target.sceneIdx
        resolvedShotIdx = Array.isArray(target.scene?.shots)
          ? Math.max(0, target.scene.shots.indexOf(target.shot))
          : panelIdx
      }
      p.finalVideoUrl = videoUrl
      p.panelStatus = 'done'
      if (lastQcReport) {
        p.continuity_status = lastQcReport.passed ? 'passed' : 'qc_failed'
        p.qcReport = {
          renderId: lastQcReport.renderId,
          score: lastQcReport.overallScore,
          passed: lastQcReport.passed,
          items: lastQcReport.records,
        }
      }
      return p
    }) as any

    if (audioUrls[0]) {
      await recordShotAssetVersion({
        chapterId,
        sceneIndex: resolvedSceneIdx,
        shotIndex: resolvedShotIdx,
        assetType: 'tts',
        url: audioUrls[0],
        prompt: cleanPanelDialogue.map((d: any) => d?.text || '').filter(Boolean).join('；'),
        status: 'done',
      })
    }
    if (videoUrl) {
      await recordShotAssetVersion({
        chapterId,
        sceneIndex: resolvedSceneIdx,
        shotIndex: resolvedShotIdx,
        assetType: 'video',
        url: videoUrl,
        prompt: content.prompt,
        modelKey: inputData.model,
        genMode: resolvedGenMode,
        duration: params.duration,
        params: { quality: inputData.quality, resolution: inputData.resolution, ratio },
        status: 'done',
      })
    }
    return { finalVideoUrl: videoUrl }
  },
})

// ============================================
// 分镜视频生成工作流
// ============================================
export const frameVideoWorkflow: any = createWorkflow({
  id: 'frame-video',
  inputSchema: z.object({
    workId: z.number().describe('作品 ID'),
    userId: z.number().describe('用户 ID'),
    chapterId: z.number().describe('章节 ID'),
    narrationVoiceId: z.number().int().nullable().optional().describe('旁白音色 ID'),
    model: z.string().min(1).describe('视频模型 ID'),
    quality: z.string().optional().describe('视频质量档位'),
    resolution: z.string().optional().describe('视频分辨率'),
    panelIdx: z.number().int().describe('当前分镜序号，从0开始'),
  }),
  outputSchema: z.object({
    finalVideoUrl: z.string().describe('最终带声音的视频 URL'),
  }),
})
  .then(FrameGeneratePanelTTS) // 生成旁白/对白 TTS
  .then(generateVideoPrompt) // 生成视频提示词
  .then(generateVideoAndMerge) // 生成视频并合成 TTS 音轨
  .commit()
