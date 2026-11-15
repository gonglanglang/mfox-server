/**
 * 分镜文本格式解析器
 *
 * 为什么不用 JSON：
 * ① **截断可救**——JSON 一旦被输出上限截断，整份数据报废、整章重跑；
 *    文本格式按块解析，前面的场景已完整，取回多少算多少，只丢最后那个不完整的镜头。
 * ② **更紧凑**——没有键名引号与括号，同等内容少 25~30%，更不容易撞上输出上限。
 * ③ **无转义问题**——JSON 里的引号、换行必须转义，模型偶尔漏转义就整份失败。
 *
 * 输入形如：
 *   【场景序号】1
 *   【场景ID】134
 *   【角色ID】33,34
 *   【道具ID】137
 *   【环境】上午，白老爷子家堂屋。...
 *   【转场】叠化
 *   【BGM】弦乐紧绷,清晨,匆忙
 *
 *   【分镜序号】1-1
 *   【衔接】continuous
 *   【景别】中全景
 *   【机位】侧面机位
 *   【运镜】固定镜头
 *   【时长】6
 *   【轴线侧】A
 *   【视线】白老爷子朝右看门外
 *   【光位】左侧门外天光斜照，暖白
 *   【画面】堂屋房门大敞，...
 *   【入点】堂屋房门大敞，白老爷子闭目端坐在太师椅上...
 *   【运动】何杰熊从右侧门外缓步走入，双手捧起白衬衫（amplitude=small）
 *   【出点】何杰熊停在太师椅前一步处，双手将白衬衫递到胸前
 *   【人物动作】白老爷子闭目端坐...
 *   【台词】旁白（平静/fluent）：白老爷子无儿无女...
 *   【台词】何杰熊（低声/sad）：……好。
 *   【音效】院外蝉鸣
 *   【道具动作】何杰熊双手取出白衬衫...
 *   【转场出】硬切
 */

export interface ShotLink {
  type: 'continuous' | 'cut' | 'transition'
  match?: 'action' | 'eyeline' | 'graphic' | 'sound' | null
  anchor?: string
}

export interface ShotMotion {
  in: string
  out: string
  path: string
  amplitude: 'micro' | 'small' | 'medium'
}

export interface ShotContinuity {
  light_dir: string
  time_of_day?: string
  wardrobe_key?: string
  prop_state?: string
}

export type VideoGenMode =
  | 'text2video'
  | 'singleImage2video'
  | 'frames2video'
  | 'image2video'
  | 'video2video'
  | 'videoEdit2video'
  | 'audio2video'
  | 'mixed2video'

export interface ShotCharacterRef {
  role_id: number | string
  name: string
  description: string
  image_url?: string
}

export interface TextStoryboardShot {
  shot_size: string
  camera_angle: string
  camera_movement: string
  content: string
  start_prompt?: string
  end_prompt?: string
  dialogue: { id: string; prop_ids: string[]; speaker: string; text: string; tone: string; emotion: string }[]
  roles: { id: string }[]
  sound_effect: string
  durShort: number
  subject_motion: string
  key_prop_action: string
  /** 镜头与上一镜的剪辑衔接关系（缺省视为 continuous，向后兼容旧数据） */
  link?: ShotLink
  /** 三段式运动分解（入点 / 出点 / 轨迹 / 幅度） */
  motion?: ShotMotion
  /** 180° 轴线侧（A 或 B） */
  axis_side?: 'A' | 'B'
  /** 视线方向与目标 */
  eyeline?: string
  /** 连续性锚点（光位、时间、服装、道具状态） */
  continuity?: ShotContinuity
  /** 本镜出点转场（硬切 / 叠化 / 淡入淡出 / 声音先入 / 画面先入 等） */
  transition_out?: string
  transition?: string

  // ★ 新增 11 个字段：对齐 LibTV 分镜表
  /** 情节/画面描述（与生图画面提示词分离） */
  plot_description?: string
  /** 分镜画面生成提示词（只描述这一张图长什么样，替代用 content 兼职） */
  image_prompt?: string
  /** 视频运动生成提示词（只描述怎么动 in→path→out，替代 subject_motion） */
  motion_prompt?: string
  /** 场景环境描述标签 */
  scene_tags?: string
  /** 灯光布局与环境氛围 */
  lighting?: string
  /** 微表情及心理状态（行级） */
  emotion?: string
  /** 角色动作/表演定位（行级） */
  character_action?: string
  /** 行级角色卡（每个镜头自己带角色名称、外观描述与参考图 URL） */
  character_refs?: ShotCharacterRef[]
  /** 该镜参考帧图 URL（图生视频/首尾帧用） */
  reference_frame_url?: string
  /** 视频生成模式（由模型 schema 的 modeType 驱动） */
  gen_mode?: VideoGenMode
  /** 该镜的模型参数快照（ratio/duration/quality 等） */
  model_params?: Record<string, unknown>
}

export interface TextStoryboardScene {
  scene_id: string
  roles: { id: string }[]
  prop_ids: string[]
  role_id: string
  environment: string
  shots: TextStoryboardShot[]
  transition: string
  bgm: string
}

/**
 * 归一化镜头的衔接关系（兼容旧数据：未配置 link 时默认按 continuous 处理）。
 */
export function normalizeShotLink(shot: { link?: Partial<ShotLink> | null } | null | undefined): ShotLink {
  const rawType = String(shot?.link?.type || '').trim().toLowerCase()
  const type: ShotLink['type'] = rawType === 'cut' || rawType === 'transition' ? rawType : 'continuous'
  const rawMatch = String(shot?.link?.match || '').trim().toLowerCase()
  const match: ShotLink['match'] =
    rawMatch === 'action' || rawMatch === 'eyeline' || rawMatch === 'graphic' || rawMatch === 'sound'
      ? rawMatch
      : null
  const anchor = String(shot?.link?.anchor || '').trim()
  return { type, match, anchor }
}

/**
 * 解析【衔接】行，形如：
 *   continuous
 *   cut | eyeline | 沈砚视线从门内转向门槛
 *   transition | sound | 雷声先入
 */
export function parseShotLinkLine(raw: string): ShotLink {
  const parts = String(raw || '').split(/[|｜]/).map(s => s.trim())
  const head = (parts[0] || '').toLowerCase()
  const type: ShotLink['type'] =
    head === 'cut' || head === '硬切' || head === '切镜'
      ? 'cut'
      : head === 'transition' || head === '转场'
        ? 'transition'
        : 'continuous'
  const matchRaw = (parts[1] || '').toLowerCase()
  const match: ShotLink['match'] =
    matchRaw === 'action' || matchRaw === '动作'
      ? 'action'
      : matchRaw === 'eyeline' || matchRaw === '视线'
        ? 'eyeline'
        : matchRaw === 'graphic' || matchRaw === '图形' || matchRaw === '相似物'
          ? 'graphic'
          : matchRaw === 'sound' || matchRaw === '声音'
            ? 'sound'
            : null
  const anchor = parts.slice(2).join(' | ').trim() || (match === null && parts[1] ? parts[1] : '')
  return { type, match, anchor }
}

/**
 * 解析【运动】行，提取运动轨迹与幅度档位（micro / small / medium）。
 */
export function parseMotionPathAndAmplitude(raw: string, durShort = 5): { path: string; amplitude: ShotMotion['amplitude'] } {
  let text = String(raw || '').trim()
  let amplitude: ShotMotion['amplitude'] | null = null

  const ampTagMatch = text.match(/[（(]\s*(?:amplitude\s*[=:：]\s*)?(micro|small|medium|微幅|小幅|中幅)\s*[）)]/i)
  if (ampTagMatch) {
    const token = ampTagMatch[1]!.toLowerCase()
    amplitude = token === 'micro' || token === '微幅'
      ? 'micro'
      : token === 'medium' || token === '中幅'
        ? 'medium'
        : 'small'
    text = text.replace(ampTagMatch[0], '').trim()
  } else if (/^(micro|small|medium)\s*[|｜:：]/i.test(text)) {
    const parts = text.split(/[|｜:：]/)
    const token = parts[0]!.trim().toLowerCase() as ShotMotion['amplitude']
    amplitude = token
    text = parts.slice(1).join('：').trim()
  }

  if (!amplitude) {
    amplitude = durShort <= 3 ? 'micro' : durShort >= 6 ? 'medium' : 'small'
  }
  return { path: text.replace(/[，,；;\s]+$/, ''), amplitude }
}

/** 标签 → 目标字段 */
const SCENE_LABELS: Record<string, keyof TextStoryboardScene | 'rolesRaw' | 'propsRaw'> = {
  '场景ID': 'scene_id',
  '主视角ID': 'role_id',
  '主视角': 'role_id',
  '角色ID': 'rolesRaw',
  '道具ID': 'propsRaw',
  '环境': 'environment',
  '环境描述': 'environment',
  '转场': 'transition',
  'BGM': 'bgm',
  '背景音乐': 'bgm',
}

const SHOT_TEXT_LABELS: Record<string, keyof TextStoryboardShot> = {
  '景别': 'shot_size',
  '拍摄尺寸': 'shot_size',
  '机位': 'camera_angle',
  '相机角度': 'camera_angle',
  '运镜': 'camera_movement',
  '镜头运动': 'camera_movement',
  '画面': 'content',
  '画面描述': 'content',
  '人物动作': 'subject_motion',
  '主体动作': 'subject_motion',
  '音效': 'sound_effect',
  '道具动作': 'key_prop_action',
  '关键道具': 'key_prop_action',
  // ★ 对齐 LibTV 分镜表新标签
  '情节': 'plot_description',
  '情节描述': 'plot_description',
  '画面提示词': 'image_prompt',
  '分镜画面提示词': 'image_prompt',
  '生图提示词': 'image_prompt',
  '运动提示词': 'motion_prompt',
  '视频运动提示词': 'motion_prompt',
  '视频运动': 'motion_prompt',
  '场景标签': 'scene_tags',
  '环境标签': 'scene_tags',
  '灯光': 'lighting',
  '灯光氛围': 'lighting',
  '灯光与氛围': 'lighting',
  '情绪': 'emotion',
  '微表情': 'emotion',
  '心理状态': 'emotion',
  '角色动作': 'character_action',
  '表演定位': 'character_action',
  '参考帧': 'reference_frame_url',
  '参考帧图': 'reference_frame_url',
}

const VALID_GEN_MODES = new Set<VideoGenMode>([
  'text2video',
  'singleImage2video',
  'frames2video',
  'image2video',
  'video2video',
  'videoEdit2video',
  'audio2video',
  'mixed2video',
])

const GEN_MODE_ALIASES: Record<string, VideoGenMode> = {
  text2video: 'text2video',
  t2v: 'text2video',
  '文生视频': 'text2video',
  singleimage2video: 'singleImage2video',
  single: 'singleImage2video',
  i2v: 'singleImage2video',
  img2vid: 'singleImage2video',
  '图生视频': 'singleImage2video',
  '单图生视频': 'singleImage2video',
  '单帧驱动': 'singleImage2video',
  frames2video: 'frames2video',
  frame2frame: 'frames2video',
  firstlast: 'frames2video',
  dual: 'frames2video',
  '首尾帧': 'frames2video',
  '首尾双帧': 'frames2video',
  image2video: 'image2video',
  fusion: 'image2video',
  '融图': 'image2video',
  '融图生视频': 'image2video',
  '图片参考': 'image2video',
  '多图参考': 'image2video',
  video2video: 'video2video',
  v2v: 'video2video',
  '视频参考': 'video2video',
  videoedit2video: 'videoEdit2video',
  '视频编辑': 'videoEdit2video',
  audio2video: 'audio2video',
  a2v: 'audio2video',
  '音频驱动': 'audio2video',
  mixed2video: 'mixed2video',
  omnimodal: 'mixed2video',
  '全能参考': 'mixed2video',
  '全模态参考': 'mixed2video',
}

/**
 * 解析【生成模式】标签，兼容英文 modeType 与中文别名。
 */
export function parseGenMode(raw: unknown): VideoGenMode | undefined {
  const token = String(raw ?? '').trim()
  if (!token) return undefined
  if (VALID_GEN_MODES.has(token as VideoGenMode)) return token as VideoGenMode
  const lower = token.toLowerCase()
  return GEN_MODE_ALIASES[lower] || GEN_MODE_ALIASES[token]
}

/**
 * 读取镜头画面提示词（兼容旧数据：image_prompt ?? content）。
 */
export function resolveShotImagePrompt(
  shot: Partial<TextStoryboardShot> | Record<string, any> | null | undefined,
): string {
  if (!shot) return ''
  const imgPrompt = typeof shot.image_prompt === 'string' ? shot.image_prompt.trim() : ''
  if (imgPrompt) return imgPrompt
  return String(shot.content ?? '').trim()
}

/**
 * 读取镜头运动提示词（兼容旧数据：motion_prompt ?? videoPrompt ?? subject_motion）。
 */
export function resolveShotMotionPrompt(
  shot: Partial<TextStoryboardShot> | Record<string, any> | null | undefined,
): string {
  if (!shot) return ''
  const motionPrompt = typeof shot.motion_prompt === 'string' ? shot.motion_prompt.trim() : ''
  if (motionPrompt) return motionPrompt
  const videoPrompt = typeof (shot as Record<string, any>).videoPrompt === 'string'
    ? (shot as Record<string, any>).videoPrompt.trim()
    : ''
  if (videoPrompt) return videoPrompt
  const subj = typeof shot.subject_motion === 'string' ? shot.subject_motion.trim() : ''
  if (subj) return subj
  if (shot.motion && typeof shot.motion === 'object') {
    const m = shot.motion as Partial<ShotMotion>
    return [m.in, m.path, m.out].map(s => String(s || '').trim()).filter(Boolean).join('；')
  }
  return ''
}

/**
 * 读取镜头情节描述（兼容旧数据：plot_description ?? content）。
 */
export function resolveShotPlotDescription(
  shot: Partial<TextStoryboardShot> | Record<string, any> | null | undefined,
): string {
  if (!shot) return ''
  const plot = typeof shot.plot_description === 'string' ? shot.plot_description.trim() : ''
  if (plot) return plot
  return String(shot.content ?? '').trim()
}

/** 兼容中英文逗号、顿号分隔的 ID 列表 */
function splitIds(raw: string): string[] {
  return String(raw || '')
    // 模型有时会照抄 JSON 字面量（没有道具时写【道具ID】[]），
    // 先去括号再切分，最后只保留纯数字，避免把 "[]" 整体当成一个 id。
    .replace(/[\[\]{}]/g, ' ')
    .split(/[,，、\s]+/)
    .map(s => s.trim())
    .filter(s => /^\d+$/.test(s))
}

function emptyShot(): TextStoryboardShot {
  return {
    shot_size: '', camera_angle: '', camera_movement: '', content: '',
    dialogue: [], roles: [], sound_effect: '', durShort: 5,
    subject_motion: '', key_prop_action: '',
  }
}

function emptyScene(): TextStoryboardScene {
  return {
    scene_id: '', roles: [], prop_ids: [], role_id: '',
    environment: '', shots: [], transition: '', bgm: '',
  }
}

/**
 * 解析【台词】行。支持：
 *   speaker（tone/emotion）：text
 *   speaker：text
 *   旁白（平静/fluent）：...
 * emotion 缺失时按 fluent（旁白默认值）填，让下游枚举校验不至于炸。
 */
export interface SpeakerCharacter {
  id: string | number
  name?: string
  display_name?: string
  description?: string
  appearance?: string
  image_url?: string
  url?: string
  content?: any
}

function extractCharacterMeta(character: SpeakerCharacter): {
  role_id: string
  name: string
  description: string
  image_url?: string
} {
  let parsedContent: Record<string, any> = {}
  if (character?.content) {
    if (typeof character.content === 'string') {
      try { parsedContent = JSON.parse(character.content) } catch { parsedContent = {} }
    } else if (typeof character.content === 'object') {
      parsedContent = character.content
    }
  }
  const role_id = String(character.id ?? '').trim()
  const name = String(character.name || character.display_name || parsedContent.name || role_id).trim()
  const description = String(
    character.description
    || character.appearance
    || parsedContent.appearance
    || parsedContent.description
    || parsedContent.prompt
    || '',
  ).trim()
  const image_url = String(
    character.image_url
    || character.url
    || parsedContent.image_url
    || parsedContent.front_url
    || parsedContent.avatar
    || '',
  ).trim() || undefined
  return { role_id, name, description, image_url }
}

/**
 * 解析【角色参考】行，支持 JSON 数组、"101:林晚(白衣长发)|https://..."、"林晚, 沈墨"、"101,102" 等写法。
 */
export function parseCharacterRefsLine(
  raw: string,
  characters?: SpeakerCharacter[] | null,
): ShotCharacterRef[] {
  const trimmed = String(raw || '').trim()
  if (!trimmed || /^(?:无|暂无|none|null|\[\]|-+)$/i.test(trimmed)) return []

  const charList = Array.isArray(characters) ? characters : []
  const byId = new Map<string, SpeakerCharacter>()
  for (const c of charList) {
    byId.set(String(c.id), c)
  }

  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      if (Array.isArray(arr)) {
        return arr
          .map((item): ShotCharacterRef | null => {
            if (!item || typeof item !== 'object') return null
            const roleId = String(item.role_id ?? item.id ?? '').trim()
            const matched = roleId ? byId.get(roleId) : undefined
            const meta = matched ? extractCharacterMeta(matched) : undefined
            const name = String(item.name || meta?.name || roleId).trim()
            const description = String(item.description || item.appearance || meta?.description || '').trim()
            const image_url = String(item.image_url || item.url || meta?.image_url || '').trim() || undefined
            if (!roleId && !name) return null
            return { role_id: roleId || name, name, description, ...(image_url ? { image_url } : {}) }
          })
          .filter((x): x is ShotCharacterRef => Boolean(x))
      }
    } catch {
      // fall through to text parsing
    }
  }

  const segments = trimmed.split(/[;；,，、]+/).map(s => s.trim()).filter(Boolean)
  const refs: ShotCharacterRef[] = []
  const seen = new Set<string>()

  for (const seg of segments) {
    const pipeParts = seg.split('|').map(s => s.trim())
    const leftPart = pipeParts[0] || ''
    const urlPart = pipeParts[1] || ''
    const extraDescPart = pipeParts.slice(2).join(' | ').trim()
    const colonMatch = leftPart.match(/^([^:：]+)[:：](.+)$/)
    let token = leftPart.trim()
    let inlineDesc = extraDescPart
    if (colonMatch) {
      token = (colonMatch[1] || '').trim()
      inlineDesc = (colonMatch[2] || '').trim() || extraDescPart
    }
    const resolvedId = resolveSpeakerRoleId(token, /^\d+$/.test(token) ? token : '', charList)
    const matched = resolvedId ? byId.get(resolvedId) : undefined
    const meta = matched ? extractCharacterMeta(matched) : undefined
    const role_id = resolvedId || token
    if (!role_id || seen.has(role_id)) continue
    seen.add(role_id)

    const cleanName = token.replace(/^\d+\s*/, '').replace(/[（(][^）)]*[）)]/g, '').trim()
    const name = meta?.name || cleanName || role_id
    const description = inlineDesc || meta?.description || ''
    const image_url = (urlPart && /^https?:\/\/|^\/|^data:/i.test(urlPart) ? urlPart : undefined) || meta?.image_url
    refs.push({
      role_id,
      name,
      description,
      ...(image_url ? { image_url } : {}),
    })
  }

  return refs
}

/**
 * 获取镜头行级角色参考卡列表（优先取 shot.character_refs，否则由 shot.roles + 角色资产表合成）。
 */
export function resolveShotCharacterRefs(
  shot: Partial<TextStoryboardShot> | Record<string, any> | null | undefined,
  characters?: SpeakerCharacter[] | null,
): ShotCharacterRef[] {
  if (!shot) return []
  const charList = Array.isArray(characters) ? characters : []
  const byId = new Map<string, SpeakerCharacter>()
  for (const c of charList) {
    byId.set(String(c.id), c)
  }

  if (Array.isArray(shot.character_refs) && shot.character_refs.length > 0) {
    return shot.character_refs
      .map((ref: any): ShotCharacterRef | null => {
        if (!ref || typeof ref !== 'object') return null
        const role_id = String(ref.role_id ?? ref.id ?? '').trim()
        const matched = role_id ? byId.get(role_id) : undefined
        const meta = matched ? extractCharacterMeta(matched) : undefined
        const name = String(ref.name || meta?.name || role_id).trim()
        const description = String(ref.description || ref.appearance || meta?.description || '').trim()
        const image_url = String(ref.image_url || ref.url || meta?.image_url || '').trim() || undefined
        if (!role_id && !name) return null
        return { role_id: role_id || name, name, description, ...(image_url ? { image_url } : {}) }
      })
      .filter((x): x is ShotCharacterRef => Boolean(x))
  }

  const roles = Array.isArray(shot.roles) ? shot.roles : []
  const result: ShotCharacterRef[] = []
  const seen = new Set<string>()
  for (const r of roles) {
    const roleId = String(typeof r === 'object' ? r?.id : r ?? '').trim()
    if (!roleId || seen.has(roleId)) continue
    seen.add(roleId)
    const matched = byId.get(roleId)
    if (matched) {
      result.push(extractCharacterMeta(matched))
    } else {
      result.push({ role_id: roleId, name: roleId, description: '' })
    }
  }
  return result
}

/**
 * 说话人 → 角色 ID。
 *
 * 历史实现里台词 id 一律用「场景主视角」兜底，导致"谁说话都一样"（典型症状：郭晴的台词
 * 配上了何杰熊的音色）。这里按说话人解析：支持直接写数字 ID，也按 name / display_name
 * 精确或宽松（去掉括号标注）匹配；只有匹配不到时才回退 fallbackId。
 */
export function resolveSpeakerRoleId(speaker: string, fallbackId: string, characters?: SpeakerCharacter[] | null): string {
  const raw = String(speaker || '').trim()
  if (!raw) return fallbackId
  const bare = raw.replace(/[（(][^）)]*[）)]/g, '').trim() || raw
  if (/^\d+$/.test(bare)) return bare
  const list = Array.isArray(characters) ? characters : []
  const namesOf = (character: SpeakerCharacter) => [character?.name, character?.display_name]
    .filter(Boolean).map(value => String(value).trim()).filter(Boolean)
  const exact = list.find(character => namesOf(character).some(name => name === raw || name === bare))
  if (exact) return String(exact.id)
  const loose = list.find(character => namesOf(character).some(name =>
    name.replace(/[（(][^）)]*[）)]/g, '').trim() === bare))
  return loose ? String(loose.id) : fallbackId
}

/**
 * 判断台词文本是否属于 LLM 输出的“无台词”占位词（如“无”、“（无）”、“无台词”、“暂无”、“None”、“-”等）。
 * 命中时严禁作为真实台词入库或送入 TTS 配音。
 */
export function isPlaceholderEmptyDialogue(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return true
  const stripped = raw
    .replace(/^[（(【\[「『"'“‘\s]+|[）)】\]」』"'”’。，,！!？?；;：:\s]+$/g, '')
    .trim()
  if (!stripped) return true
  return /^(?:无|暂无|无台词|无对白|无旁白|没有台词|没有对白|无声音|静音|沉默|留白|空|none|null|nil|n\/a|-+|—+|_+|\.+|…+)$/i.test(stripped)
}

/**
 * 过滤对白列表中的空台词与“无”占位词。
 */
export function sanitizeDialogueList<T extends { text?: any } = any>(dialogue: T[] | null | undefined): T[] {
  if (!Array.isArray(dialogue)) return []
  return dialogue.filter(line => line && !isPlaceholderEmptyDialogue(line.text))
}

function parseDialogueLine(raw: string, fallbackId: string, characters?: SpeakerCharacter[]): TextStoryboardShot['dialogue'][number] | null {
  const text = raw.trim()
  if (!text || isPlaceholderEmptyDialogue(text)) return null

  // 全角/半角冒号都接受；只切第一个冒号，避免台词里含冒号被截断
  const sepMatch = text.match(/[:：]/)
  if (!sepMatch || sepMatch.index === undefined) {
    // 没写说话人，整行当台词正文，说话人用场景主角兜底
    return { id: fallbackId, prop_ids: [], speaker: '旁白', text, tone: '', emotion: 'fluent' }
  }
  const head = text.slice(0, sepMatch.index).trim()
  const body = text.slice(sepMatch.index + 1).trim()
  if (!body || isPlaceholderEmptyDialogue(body)) return null

  // head 可能形如：
  //   郭晴（沉声/calm）           → speaker=郭晴      tone=沉声  emotion=calm
  //   何杰熊（内心OS）（低声/sad） → speaker=何杰熊（内心OS）tone=低声  emotion=sad
  //   郭晴                        → speaker=郭晴      tone=""   emotion=""
  // 取【末尾那个】圆括号作为语气/emotion，前面整体是说话人（含"（内心OS）"这类后缀）。
  const m = head.match(/^(.*?)[（(]([^）)]*)[）)]\s*$/)
  let speaker = head
  let tone = ''
  let emotion = ''
  if (m) {
    speaker = (m[1] || '').trim()
    const parts = (m[2] || '').split(/[/／]/).map(s => s.trim())
    tone = parts[0] || ''
    emotion = parts[1] || ''
  }
  if (!speaker) speaker = head

  // 说话人若是"X（内心OS）"这种，保留整串（下游按 speaker 命名规则处理）
  const speakerFull = tone || emotion ? speaker : head.replace(/[（(].*$/, '').trim() || speaker
  const toneOut = tone
  const isNarr = /旁白/.test(head)
  const emotionOut = emotion || (isNarr ? 'fluent' : 'calm')

  return {
    // 角色归属看说话人，而不是场景主视角（旁白不占角色，下游按 narration 处理）
    id: isNarr ? fallbackId : resolveSpeakerRoleId(speakerFull || head, fallbackId, characters),
    prop_ids: [],
    speaker: speakerFull || head,
    text: body,
    tone: toneOut,
    emotion: emotionOut,
  }
}

function ensureMotion(shot: TextStoryboardShot): ShotMotion {
  if (!shot.motion) {
    shot.motion = {
      in: '',
      out: '',
      path: '',
      amplitude: shot.durShort <= 3 ? 'micro' : shot.durShort >= 6 ? 'medium' : 'small',
    }
  }
  return shot.motion
}

/**
 * 把分镜文本解析成与原先 JSON 完全一致的结构。
 *
 * **容忍截断**：最后一个镜头若缺【画面】等必填字段，视为不完整并丢弃，
 * 已解析完成的场景照常返回——这正是换掉 JSON 的主要目的。
 */
export function parseStoryboardText(text: string, characters?: SpeakerCharacter[]): TextStoryboardScene[] {
  const lines = String(text || '').split(/\r?\n/)

  const scenes: TextStoryboardScene[] = []
  let scene: TextStoryboardScene | null = null
  let shot: TextStoryboardShot | null = null
  let shotComplete = false // 是否已见到【画面】或【入点】，用于判断该镜头是否写完

  /** 镜头必需字段：景别/机位/运镜/画面（台词、音效、时长允许为空，时长有兜底） */
  const REQUIRED_SHOT_FIELDS: { key: 'shot_size' | 'camera_angle' | 'camera_movement'; label: string }[] = [
    { key: 'shot_size', label: '景别' },
    { key: 'camera_angle', label: '机位' },
    { key: 'camera_movement', label: '运镜' },
  ]

  const flushShot = () => {
    if (!scene || !shot) return
    // ★ 双提示词与旧字段双向兜底同步（image_prompt ?? content，motion_prompt ?? subject_motion）
    if (!shot.content.trim()) {
      if (shot.image_prompt?.trim()) {
        shot.content = shot.image_prompt.trim()
      } else if (shot.plot_description?.trim()) {
        shot.content = shot.plot_description.trim()
      } else if (shot.motion?.in?.trim()) {
        shot.content = shot.motion.in.trim()
      }
    }
    if (!shot.image_prompt?.trim() && shot.content.trim()) {
      shot.image_prompt = shot.content.trim()
    }
    if (!shot.plot_description?.trim() && shot.content.trim()) {
      shot.plot_description = shot.content.trim()
    }
    if (!shot.start_prompt?.trim()) {
      shot.start_prompt = (shot.image_prompt || shot.motion?.in || shot.content || '').trim()
    }
    if (!shot.end_prompt?.trim()) {
      shot.end_prompt = (shot.motion?.out || shot.image_prompt || shot.start_prompt || shot.content || '').trim()
    }

    if (!shot.subject_motion.trim()) {
      if (shot.motion_prompt?.trim()) {
        shot.subject_motion = shot.motion_prompt.trim()
      } else if (shot.character_action?.trim()) {
        shot.subject_motion = shot.character_action.trim()
      } else if (shot.motion) {
        const { in: mIn, path: mPath, out: mOut } = shot.motion
        shot.subject_motion = [mIn, mPath, mOut].map(s => String(s || '').trim()).filter(Boolean).join('；')
      }
    }
    if (!shot.motion_prompt?.trim() && shot.subject_motion.trim()) {
      shot.motion_prompt = shot.subject_motion.trim()
    }
    if (!shot.character_action?.trim() && shot.subject_motion.trim()) {
      shot.character_action = shot.subject_motion.trim()
    }

    if (shot.lighting?.trim() && !shot.continuity?.light_dir) {
      shot.continuity = { ...(shot.continuity || { light_dir: '' }), light_dir: shot.lighting.trim() }
    } else if (!shot.lighting?.trim() && shot.continuity?.light_dir) {
      shot.lighting = shot.continuity.light_dir
    }

    if (shotComplete) {
      // 必需字段缺失属于模型输出格式错误：直接报错让上游重出，不默默补默认值。
      const missing = REQUIRED_SHOT_FIELDS.filter(field => !String(shot![field.key] || '').trim())
      if (!String(shot.content || '').trim()) missing.push({ key: 'shot_size', label: '画面' })
      if (missing.length) {
        const brief = String(shot.content || shot.subject_motion || '').slice(0, 20)
        throw new Error(`分镜格式错误：镜头缺少【${missing.map(field => field.label).join('】【')}】`
          + `${brief ? `（镜头内容片段：${brief}…）` : ''}，请补全后重新输出`)
      }
      if (scene.shots.length > 0 && !shot.link) {
        console.warn(`[分镜解析] 场景 ${scene.scene_id || '?'} 第 ${scene.shots.length + 1} 镜未显式声明【衔接】类型，已默认按 continuous 处理`)
      }
      shot.roles = shot.roles.length ? shot.roles : scene.roles
      if (shot.character_refs?.length && !shot.roles.length) {
        shot.roles = shot.character_refs
          .filter(r => r.role_id != null && /^\d+$/.test(String(r.role_id)))
          .map(r => ({ id: String(r.role_id) }))
      }
      if ((!shot.character_refs || !shot.character_refs.length) && Array.isArray(characters) && characters.length > 0) {
        const resolvedRefs = resolveShotCharacterRefs(shot, characters)
        if (resolvedRefs.length > 0) {
          shot.character_refs = resolvedRefs
        }
      }
      scene.shots.push(shot)
    }
    // 没有【画面】/【入点】的残块视为被输出上限截断：丢弃而不是污染结果（这是文本格式能"截断可救"的前提）
    shot = null
    shotComplete = false
  }

  const flushScene = () => {
    flushShot()
    if (scene && scene.scene_id) scenes.push(scene)
    scene = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const tag = line.match(/^【([^】]+)】\s*(.*)$/)
    if (!tag) {
      // 非标签行：作为上一行内容的续写（模型偶尔会换行写长句）
      if (shot && shot.content) shot.content += line
      else if (scene && scene.environment) scene.environment += line
      continue
    }

    const label = (tag[1] || '').trim()
    const value = (tag[2] || '').trim()

    // ── 场景起始 ──
    if (label === '场景序号') {
      flushScene()
      scene = emptyScene()
      continue
    }

    // ── 镜头起始 ──
    if (label === '分镜序号' || label === '镜头序号') {
      flushShot()
      shot = emptyShot()
      // 分镜序号形如 1-2；若是纯数字也接受，下游不依赖它
      if (scene) shot.roles = scene.roles.slice()
      continue
    }

    // ── 镜头级字段 ──
    if (shot) {
      if (label === '时长' || label === '持续时间') {
        const n = parseInt(value.replace(/[^\d]/g, ''), 10)
        // 单镜 2~15 秒（反应镜头允许 2s，常规镜头 3~15s）；超出说明模型没有拆镜，夹到范围并留日志便于排查
        if (Number.isFinite(n) && n > 0) {
          if (n < 2 || n > 15) console.warn(`[分镜解析] 镜头时长 ${n}s 超出 2~15s 范围，已夹到 2~15s`)
          shot.durShort = Math.max(2, Math.min(15, n))
        }
        continue
      }
      if (label === '台词' || label === '对白' || label === '字幕') {
        const line1 = parseDialogueLine(value, scene?.role_id || '', characters)
        if (line1) shot.dialogue.push(line1)
        continue
      }
      if (label === '角色ID' || label === '出镜角色') {
        shot.roles = splitIds(value).map(id => ({ id }))
        continue
      }
      if (label === '衔接' || label === '镜头衔接') {
        shot.link = parseShotLinkLine(value)
        continue
      }
      if (label === '入点' || label === '起点姿态' || label === '首帧状态') {
        const m = ensureMotion(shot)
        m.in = value
        if (!shot.content) shot.content = value
        shotComplete = true
        continue
      }
      if (label === '出点' || label === '终点姿态' || label === '尾帧状态') {
        const m = ensureMotion(shot)
        m.out = value
        continue
      }
      if (label === '运动' || label === '动作轨迹') {
        const m = ensureMotion(shot)
        const parsed = parseMotionPathAndAmplitude(value, shot.durShort)
        m.path = parsed.path
        m.amplitude = parsed.amplitude
        continue
      }
      if (label === '轴线侧' || label === '轴线') {
        const side = value.trim().toUpperCase()
        if (side === 'A' || side === 'B') shot.axis_side = side
        continue
      }
      if (label === '视线' || label === '视线方向') {
        shot.eyeline = value
        continue
      }
      if (label === '光位' || label === '主光方向') {
        shot.continuity = { ...(shot.continuity || { light_dir: '' }), light_dir: value }
        continue
      }
      if (label === '转场出' || label === '镜头转场') {
        if (value) {
          shot.transition_out = value
          shot.transition = value
        }
        continue
      }
      if (label === '角色参考' || label === '角色参考卡' || label === '出镜角色卡') {
        const refs = parseCharacterRefsLine(value, characters)
        if (refs.length > 0) {
          shot.character_refs = refs
        }
        continue
      }
      if (label === '生成模式' || label === '视频生成模式' || label === '模式') {
        const mode = parseGenMode(value)
        if (mode) shot.gen_mode = mode
        continue
      }
      if (label === '模型参数') {
        if (value.startsWith('{')) {
          try {
            const parsed = JSON.parse(value)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              shot.model_params = parsed
            }
          } catch {
            // ignore malformed model_params JSON
          }
        }
        continue
      }
      const shotField = SHOT_TEXT_LABELS[label]
      if (shotField && (typeof shot[shotField] === 'string' || shot[shotField] === undefined)) {
        ;(shot as any)[shotField] = value
        if (shotField === 'content' || shotField === 'image_prompt' || shotField === 'plot_description') {
          shotComplete = true
        }
        continue
      }
      // 未识别的镜头级标签：忽略（不阻断）
      continue
    }

    // ── 场景级字段 ──
    if (scene) {
      if (label === '角色ID' || label === '出镜角色') {
        const ids = splitIds(value).map(id => ({ id }))
        scene.roles = ids
        // 模型没写【主视角ID】时，用第一个角色兜底
        if (!scene.role_id) scene.role_id = ids[0]?.id || ''
        continue
      }
      if (label === '道具ID') { scene.prop_ids = splitIds(value); continue }
      const sceneField = SCENE_LABELS[label]
      if (sceneField && typeof sceneField === 'string' && sceneField !== 'rolesRaw' && sceneField !== 'propsRaw') {
        ;(scene as any)[sceneField] = value
        continue
      }
    }
  }

  // 收尾：flushScene 会顺带把最后一个镜头 flush 掉。
  // 若最后一个镜头恰好被截断（缺 content），flushShot 内部会丢弃它——
  // 前面的场景与镜头仍然完整返回。
  flushScene()

  return scenes
}
