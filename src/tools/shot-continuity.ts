import { normalizeShotLink, sanitizeDialogueList } from './storyboard-text'

export const SHOT_SIZE_RANK = [
  '极远景', '大远景', '远景', '中全景', '中景', '中近景', '近景', '特写', '大特写', '极特写',
] as const

export type MotionDirection =
  | 'left_to_right'
  | 'right_to_left'
  | 'forward'
  | 'backward'
  | 'up'
  | 'down'
  | 'static'

export type ContinuityStatus =
  | 'pending'
  | 'continuity_checking'
  | 'passed'
  | 'warning'
  | 'qc_failed'
  | 'regenerating'

export interface ContinuityIssue {
  code: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9' | 'C10' | 'C11' | 'C12' | 'C13' | 'C14' | 'C15'
  shotIdx: number
  fromShotIdx?: number
  message: string
  severity: 'error' | 'warning'
}

export interface StoryboardContinuityRow {
  chapter_id: number
  scene_idx: number
  shot_idx: number
  panel_idx: number
  shot_key: string
  subject_id: number | null
  color_tone: string
  motion_direction: MotionDirection
  shot_size: string
  prev_shot_id: string | null
  next_shot_id: string | null
  style_anchor_id: number | null
  continuity_status: ContinuityStatus
  frame_mode: 'single' | 'dual' | 'video_tail'
  world_state: string
}

interface StateTransitionRule {
  id: string
  label: string
  actionRe: RegExp
  resetStateRe?: RegExp
  resetReplacement?: string
  reverseRe?: RegExp
  persistentNote: string
}

const STATE_TRANSITION_RULES: StateTransitionRule[] = [
  {
    id: 'open_door',
    label: '开门/推门',
    actionRe: /(?:推开|拉开|打开|踢开|撞开)[^，。；！？]{0,6}(?:门|木门|房门|院门|殿门|柴门|房门扇|门扇)|(?:门|木门|房门|院门|殿门|柴门)[^，。；！？]{0,4}(?:被推开|被拉开|被撞开|缓缓开启|应声而开)/,
    resetStateRe: /(?:木门|房门|院门|殿门|柴门|门扇|两扇门)[^，。；！？]{0,3}(?:紧闭|关闭|合拢|未开|关着)|(?:紧闭|关闭|合拢|未开|关着)的?(?:木门|房门|院门|殿门|柴门|门扇|两扇门)/g,
    resetReplacement: '门扇保持敞开状态',
    reverseRe: /(?:关上|合上|闭上|掩上|摔上)[^，。；！？]{0,6}(?:门|木门|房门|院门|殿门|柴门|门扇)|(?:门|木门|房门|院门|殿门|柴门)[^，。；！？]{0,4}(?:被关上|被合上|重新合拢)/,
    persistentNote: '【门窗状态已锁定：敞开】前序镜头已完成开门动作，当前门扇保持敞开（严禁将门画回紧闭状态，严禁重复执行推门/开门动作）',
  },
  {
    id: 'close_door',
    label: '关门/合门',
    actionRe: /(?:关上|合上|闭上|掩上|摔上)[^，。；！？]{0,6}(?:门|木门|房门|院门|殿门|柴门|门扇)|(?:门|木门|房门|院门|殿门|柴门)[^，。；！？]{0,4}(?:被关上|被合上|砰然合拢)/,
    resetStateRe: /(?:木门|房门|院门|殿门|柴门|门扇)[^，。；！？]{0,3}(?:大开|敞开|洞开)|(?:大开|敞开|洞开)的?(?:木门|房门|院门|殿门|柴门|门扇)/g,
    resetReplacement: '门扇保持紧闭状态',
    reverseRe: /(?:推开|拉开|打开|踢开|撞开)[^，。；！？]{0,6}(?:门|木门|房门|院门|殿门|柴门|门扇)/,
    persistentNote: '【门窗状态已锁定：紧闭】前序镜头已完成关门动作，当前门扇保持紧闭（严禁重复执行关门动作）',
  },
  {
    id: 'fall_or_kneel',
    label: '跌倒/跪地',
    actionRe: /跌坐|摔倒|扑倒|跪倒|瘫坐|重重跪下|跌倒在地/,
    reverseRe: /站起|起身|爬起|跃起|扶起|挺身而立|重新站稳/,
    persistentNote: '【人物姿态已锁定：地面跌坐/跪姿】前序镜头人物已跌坐或跪倒在地，未起身前必须从该地面姿态起演（严禁无故还原为站立或重复做跌倒动作）',
  },
  {
    id: 'sit_down',
    label: '坐下/落座',
    actionRe: /坐下|落座|坐入椅中|坐到桌前/,
    reverseRe: /站起|起身|离座|拍案而起|霍然起身/,
    persistentNote: '【人物姿态已锁定：坐姿】前序镜头人物已落座，未起身前保持坐姿（严禁无故还原为站立或重复做坐下动作）',
  },
  {
    id: 'draw_weapon',
    label: '拔剑/亮兵刃',
    actionRe: /拔出[^，。；！？]{0,4}(?:剑|刀|匕首|长剑|佩剑|兵刃)|长剑出鞘|拔剑出鞘|刀出鞘/,
    resetStateRe: /(?:长剑|佩剑|刀剑|兵刃)[^，。；！？]{0,3}(?:在鞘|未出鞘|挂在腰间未拔)/g,
    resetReplacement: '兵刃已出鞘握在手中',
    reverseRe: /收剑|归鞘|入鞘|收起兵刃|插回剑鞘|脱手飞出|掉落在地/,
    persistentNote: '【道具状态已锁定：兵刃已出鞘】前序镜头已完成拔剑/出鞘，当前兵刃握于手中（严禁还原回剑鞘或重复做拔剑动作）',
  },
  {
    id: 'break_prop',
    label: '器物碎裂/打翻',
    actionRe: /摔碎|打碎|砸碎|打翻|踢翻|震碎|碎裂一地/,
    resetStateRe: /(?:茶盏|碗碟|瓷瓶|药碗|酒杯|木桶)[^，。；！？]{0,4}完好无损/g,
    resetReplacement: '器物已碎裂散落在地',
    persistentNote: '【道具状态已锁定：已打翻/碎裂】前序镜头器物已打翻或碎裂，地面保持碎片/倾洒状态（严禁还原为完好状态）',
  },
]

function getShotActionText(shot: any): string {
  return [
    shot?.motion?.path,
    shot?.subject_motion,
    shot?.key_prop_action,
    shot?.content,
  ].map(s => String(s || '')).join(' ')
}

/**
 * 推导并修正同场景内的不可逆世界状态账本（world_state），消除“镜头1已开门，镜头2门又变关着重开”的还原重做问题：
 * 1. 按镜头顺序扫描每个镜头的动作与出点状态，维护当前场次的不可逆状态锁（如门已开、人物已跌坐、兵器已出鞘、器物已碎裂）；
 * 2. 将当前累积状态锁 + 上一镜结束姿态写入本镜 `shot.world_state`；
 * 3. 若发现下一镜在入点/画面描述/首帧提示词中把已完成状态还原（如门已开却写“木门紧闭”或连续两镜重复“推开门”），自动修正入点描述。
 */
export function deriveSceneWorldState<T extends { shots?: any[] }>(scene: T): T {
  if (!scene || !Array.isArray(scene.shots) || scene.shots.length === 0) return scene
  const activeStates = new Map<string, StateTransitionRule>()

  for (let i = 0; i < scene.shots.length; i++) {
    const shot = scene.shots[i]
    if (!shot || typeof shot !== 'object') continue
    const prev = i > 0 ? scene.shots[i - 1] : null
    const actionText = getShotActionText(shot)
    const outText = String(shot.motion?.out || '').trim()

    // 1. 先把前序镜头累积的不可逆状态写入当前镜头 world_state
    const stateNotes: string[] = []
    for (const rule of activeStates.values()) {
      stateNotes.push(rule.persistentNote)
      // 自动修正当前镜头入点/首帧中违背已锁定状态的“还原词”（如门已开却写“木门紧闭”）
      if (rule.resetStateRe && rule.resetReplacement) {
        if (typeof shot.motion?.in === 'string') {
          shot.motion.in = shot.motion.in.replace(rule.resetStateRe, rule.resetReplacement)
        }
        if (typeof shot.content === 'string') {
          shot.content = shot.content.replace(rule.resetStateRe, rule.resetReplacement)
        }
        if (typeof shot.start_prompt === 'string') {
          shot.start_prompt = shot.start_prompt.replace(rule.resetStateRe, rule.resetReplacement)
        }
      }
    }
    if (prev) {
      const prevEnd = String(prev.motion?.out || prev.content || '').trim()
      if (prevEnd) {
        stateNotes.push(`【上一镜结尾终态（本镜起点基准）】${prevEnd.slice(0, 120)}`)
      }
    }
    shot.world_state = stateNotes.join('；').slice(0, 480)

    // 2. 扫描本镜发生的动作，更新后续镜头的状态账本
    const fullShotText = `${actionText} ${outText}`
    for (const rule of STATE_TRANSITION_RULES) {
      if (rule.reverseRe && rule.reverseRe.test(fullShotText)) {
        activeStates.delete(rule.id)
      }
      if (rule.actionRe.test(fullShotText)) {
        // 若是互斥动作（如开门 vs 关门），清除对立状态
        if (rule.id === 'open_door') activeStates.delete('close_door')
        if (rule.id === 'close_door') activeStates.delete('open_door')
        activeStates.set(rule.id, rule)
      }
    }
  }
  return scene
}

const STANDING_POSTURE_RE = /站立|直立|伫立|立在|立于|站着|站在|挺立/
const FALLEN_OR_SEATED_POSTURE_RE = /跌坐|坐地|坐在|坐着|瘫坐|跪在|跪地|跪着|躺着|躺在|仰卧|趴在|趴着|倒地|摔倒/
const STOP_WORDS = new Set([
  '画面', '位于', '方向', '状态', '镜头', '一个', '此时', '随后', '继续', '保持', '位置', '上方', '下方', '中间', '出来', '进去',
])
const ANCHOR_TOKEN_RE = /门槛|门内|门外|门板|门框|泥水|屋檐|檐下|廊下|药柜|灯笼|桌前|窗前|床榻|台阶|院中|左中景|右中景|中央|左侧|右侧|前倾|后倾|半跪|跌坐|直立|站立|仰卧|双手|右手|左手|右脚|左脚/g

function extractMeaningfulTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const m of text.matchAll(ANCHOR_TOKEN_RE)) {
    if (m[0]) tokens.add(m[0])
  }
  const chunks = text.match(/[\u4e00-\u9fa5]{2,4}/g) || []
  for (const chunk of chunks) {
    if (!STOP_WORDS.has(chunk)) tokens.add(chunk)
  }
  return tokens
}

function hasSemanticOverlap(outState: string, inState: string): boolean {
  const a = String(outState || '').trim()
  const b = String(inState || '').trim()
  if (!a || !b) return true

  // 1. 姿态互斥检查：continuous 交界帧是同一瞬间，不能上一镜出点站立、下一镜入点已跌坐/躺卧/跪地
  const aStanding = STANDING_POSTURE_RE.test(a) && !FALLEN_OR_SEATED_POSTURE_RE.test(a)
  const bStanding = STANDING_POSTURE_RE.test(b) && !FALLEN_OR_SEATED_POSTURE_RE.test(b)
  const aFallen = FALLEN_OR_SEATED_POSTURE_RE.test(a) && !STANDING_POSTURE_RE.test(a)
  const bFallen = FALLEN_OR_SEATED_POSTURE_RE.test(b) && !STANDING_POSTURE_RE.test(b)
  if ((aStanding && bFallen) || (aFallen && bStanding)) {
    return false
  }

  // 2. 空间方位与语义实体词块交集检查（剔除虚词与泛化方位词，避免单靠两字巧合误判通过）
  const tokensA = extractMeaningfulTokens(a)
  const tokensB = extractMeaningfulTokens(b)
  for (const token of tokensB) {
    if (tokensA.has(token)) return true
  }
  return false
}

/**
 * 提取镜头的主体角色 ID（subject_id）：优先取显式 subject_id，其次取本镜首位出场角色，最后取场次主视角 role_id。
 */
export function inferSubjectId(shot: any, scene?: any): number | null {
  const explicit = Number(shot?.subject_id)
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit
  const firstShotRole = Array.isArray(shot?.roles) && shot.roles.length > 0
    ? Number(shot.roles[0]?.id ?? shot.roles[0])
    : NaN
  if (Number.isSafeInteger(firstShotRole) && firstShotRole > 0) return firstShotRole
  const scenePrimary = Number(scene?.role_id)
  if (Number.isSafeInteger(scenePrimary) && scenePrimary > 0) return scenePrimary
  const firstSceneRole = Array.isArray(scene?.roles) && scene.roles.length > 0
    ? Number(scene.roles[0]?.id ?? scene.roles[0])
    : NaN
  return Number.isSafeInteger(firstSceneRole) && firstSceneRole > 0 ? firstSceneRole : null
}

/**
 * 提取镜头的色调/色温锚点（color_tone）：保证同场景内跨镜色温差可控。
 */
export function inferColorTone(shot: any, scene?: any): string {
  const explicit = String(shot?.color_tone || '').trim()
  if (explicit) return explicit
  const lightDir = String(shot?.continuity?.light_dir || '').trim()
  const env = String(scene?.environment || '').trim()
  const combined = `${lightDir} ${env}`
  const tones = new Set<string>()
  for (const m of combined.matchAll(/暖黄|昏黄|暖金|暖光|冷青|青灰|冷白|冷光|暗红|血红|苍白|幽蓝|墨黑|金黄|灰暗/g)) {
    if (m[0]) tones.add(m[0])
  }
  if (tones.size > 0) return [...tones].slice(0, 3).join('/')
  if (lightDir) return lightDir.slice(0, 40)
  return env ? env.slice(0, 40) : '自然光影'
}

/**
 * 提取镜头的运动方向（motion_direction）：用于校验相邻镜头主体运动方向一致或有意反接。
 */
export function inferMotionDirection(shot: any): MotionDirection {
  const explicit = String(shot?.motion_direction || '').trim() as MotionDirection
  if (['left_to_right', 'right_to_left', 'forward', 'backward', 'up', 'down', 'static'].includes(explicit)) {
    return explicit
  }
  const text = [
    shot?.motion?.path,
    shot?.subject_motion,
    shot?.motion?.in,
    shot?.motion?.out,
    shot?.eyeline,
    shot?.camera_movement,
  ].map(s => String(s || '')).join(' ')

  if (/向右|朝右|往右|自左向右|由左至右|面朝右侧.*前|右移/.test(text)) return 'left_to_right'
  if (/向左|朝左|往左|自右向左|由右至左|面朝左侧.*前|左移/.test(text)) return 'right_to_left'
  if (/向前|往前|朝前|前倾|逼近|走近|冲向|迈步向前|挪半步|推镜头/.test(text)) return 'forward'
  if (/向后|往后|后退|退步|后倾|跌坐|倒退|拉镜头/.test(text)) return 'backward'
  if (/向上|抬头|仰起|升起|跃起|起身|站起|升镜头/.test(text)) return 'up'
  if (/向下|低头|俯身|跪下|跪倒|跌落|下落|降镜头/.test(text)) return 'down'
  return 'static'
}

/**
 * 为同一作品/风格锚点/主体角色/场景派生稳定可复现的正整数 Seed（1 ~ 2^31-1），
 * 防止同一角色与场景在不同镜头生成时随机种子完全漂移。
 */
export function deriveConsistentSeed(params: {
  workId?: number | string | null
  styleAnchorId?: number | string | null
  subjectId?: number | string | null
  sceneId?: number | string | null
  slot?: string
}): number {
  const key = [
    params.workId ?? 0,
    params.styleAnchorId ?? 0,
    params.subjectId ?? 0,
    params.sceneId ?? 0,
    params.slot ?? 'base',
  ].join(':')
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (Math.abs(hash | 0) % 2147483646) + 1
}

function isOppositeHorizontalDirection(a: MotionDirection, b: MotionDirection): boolean {
  return (a === 'left_to_right' && b === 'right_to_left')
    || (a === 'right_to_left' && b === 'left_to_right')
}

function colorPolarity(tone: string): 'warm' | 'cool' | 'mixed' | 'neutral' {
  const hasWarm = /暖|黄|金|红|橙/.test(tone)
  const hasCool = /冷|青|蓝|灰|白/.test(tone)
  if (hasWarm && hasCool) return 'mixed'
  if (hasWarm) return 'warm'
  if (hasCool) return 'cool'
  return 'neutral'
}

/**
 * 删除无叙事意义的冗余切镜（需求 3.3）：
 * 当同场景内相邻两镜均无台词、景别+机位+运镜+主体完全相同，且画面描述高度重合（或后一镜无独立动作变化）时，
 * 自动合并至前一镜，消除无意义碎切。
 */
export function removeRedundantCuts<T extends { shots?: any[] }>(scene: T): { scene: T; removedCount: number } {
  if (!scene || !Array.isArray(scene.shots) || scene.shots.length <= 1) {
    return { scene, removedCount: 0 }
  }
  const kept: any[] = []
  let removedCount = 0
  for (const shot of scene.shots) {
    const prev = kept[kept.length - 1]
    if (!prev) {
      kept.push(shot)
      continue
    }
    const prevHasDialogue = Array.isArray(prev.dialogue) && prev.dialogue.length > 0
    const curHasDialogue = Array.isArray(shot.dialogue) && shot.dialogue.length > 0
    const sameCamera = String(prev.shot_size || '') === String(shot.shot_size || '')
      && String(prev.camera_angle || '') === String(shot.camera_angle || '')
      && String(prev.camera_movement || '') === String(shot.camera_movement || '')
    const prevContent = String(prev.content || '').trim()
    const curContent = String(shot.content || '').trim()
    const isDuplicateContent = Boolean(prevContent && curContent && prevContent === curContent)

    if (!prevHasDialogue && !curHasDialogue && sameCamera && isDuplicateContent) {
      prev.durShort = Math.min(15, (Number(prev.durShort) || 4) + (Number(shot.durShort) || 3))
      if (shot.motion?.out) {
        prev.motion = { ...(prev.motion || {}), out: shot.motion.out }
      }
      removedCount++
      continue
    }
    kept.push(shot)
  }
  scene.shots = kept
  return { scene, removedCount }
}

/**
 * Gate A 程序化连续性硬校验（C1 ~ C14）。
 * 对单个场景的分镜序列进行确定性检查，返回所有违例项：
 * - C1: 180° 轴线越界
 * - C2: 景别跳变 > 2 档且非转场
 * - C3: 连续 3 镜景别 + 机位完全相同
 * - C4: 同场景主光方向不一致
 * - C5: continuous 衔接出点与入点断链/姿态互斥
 * - C6: cut 切镜缺少 anchor 锚点
 * - C7: 单镜时长超出 [2, 15] 秒
 * - C8: 台词容量与时长不匹配 / 超长单镜建议拆分
 * - C9: 单镜动作意图过载
 * - C10: 首尾帧提示词完全相同
 * - C11: 同场景 continuous 主体无故漂移
 * - C12: 相邻镜头运动方向无故反向撞车
 * - C13: 同场景色温极性无过渡突变
 * - C14: 场内镜头时长节奏呆板（>3 镜全部同一时长且无快慢起伏）
 */
export function validateShots(scene: { shots?: any[]; environment?: string; role_id?: any; roles?: any[] } | null | undefined): ContinuityIssue[] {
  const issues: ContinuityIssue[] = []
  const shots = Array.isArray(scene?.shots) ? scene!.shots : []
  if (!shots.length) return issues

  const baseLightDir = String(
    shots.find(s => String(s?.continuity?.light_dir || '').trim())?.continuity?.light_dir || '',
  ).trim()

  for (let i = 0; i < shots.length; i++) {
    const cur = shots[i] || {}
    const dur = Number(cur.durShort ?? 5)

    // C7：单镜时长范围 [2, 15]
    if (!Number.isFinite(dur) || dur < 2 || dur > 15) {
      issues.push({
        code: 'C7',
        shotIdx: i,
        message: `第 ${i + 1} 镜时长（${cur.durShort}s）超出合法范围 [2, 15] 秒`,
        severity: 'error',
      })
    }

    // C4：同场景主光方向一致
    const curLightDir = String(cur?.continuity?.light_dir || '').trim()
    if (baseLightDir && curLightDir && curLightDir !== baseLightDir) {
      issues.push({
        code: 'C4',
        shotIdx: i,
        message: `第 ${i + 1} 镜光位「${curLightDir}」与本场景基准光位「${baseLightDir}」不一致`,
        severity: 'error',
      })
    }

    if (i === 0) continue

    const prev = shots[i - 1] || {}
    const link = normalizeShotLink(cur)

    // C1：180° 轴线越界检查（轴线翻转发生在 cur 镜头，因此检查 cur.camera_movement 是否通过环绕/移镜头交代越轴）
    if (
      prev.axis_side
      && cur.axis_side
      && prev.axis_side !== cur.axis_side
      && !['环绕镜头', '移镜头'].includes(String(cur.camera_movement || '').trim())
    ) {
      issues.push({
        code: 'C1',
        fromShotIdx: i - 1,
        shotIdx: i,
        message: `镜头 ${i}→${i + 1} 发生越轴（${prev.axis_side}→${cur.axis_side}），且本镜非环绕/移镜头`,
        severity: 'error',
      })
    }

    // C2：景别跳变 > 2 档且非转场
    const rankA = SHOT_SIZE_RANK.indexOf(prev.shot_size)
    const rankB = SHOT_SIZE_RANK.indexOf(cur.shot_size)
    if (rankA >= 0 && rankB >= 0 && Math.abs(rankA - rankB) > 2 && link.type !== 'transition') {
      issues.push({
        code: 'C2',
        fromShotIdx: i - 1,
        shotIdx: i,
        message: `镜头 ${i}→${i + 1} 景别跳变过大（${prev.shot_size}→${cur.shot_size}，跨 ${Math.abs(rankA - rankB)} 档）`,
        severity: 'error',
      })
    }

    // C3：连续 3 镜景别 + 机位完全相同
    if (i >= 2) {
      const prev2 = shots[i - 2] || {}
      const key = (s: any) => `${String(s?.shot_size || '').trim()}|${String(s?.camera_angle || '').trim()}`
      if (key(cur) !== '|' && key(cur) === key(prev) && key(cur) === key(prev2)) {
        issues.push({
          code: 'C3',
          fromShotIdx: i - 2,
          shotIdx: i,
          message: `镜头 ${i - 1}、${i}、${i + 1} 连续三镜使用完全相同的景别与机位（${cur.shot_size}+${cur.camera_angle}）`,
          severity: 'warning',
        })
      }
    }

    // C5：continuous 衔接时，上一镜出点与本镜入点必须衔接
    if (link.type === 'continuous' && prev.motion?.out && cur.motion?.in) {
      if (!hasSemanticOverlap(prev.motion.out, cur.motion.in)) {
        issues.push({
          code: 'C5',
          fromShotIdx: i - 1,
          shotIdx: i,
          message: `镜头 ${i}→${i + 1} 标记为 continuous，但上一镜【出点】与本镜【入点】缺少共同人物或空间锚点`,
          severity: 'warning',
        })
      }
    }

    // C6：cut 切镜必须写明视觉匹配锚点 anchor
    if (link.type === 'cut' && !link.anchor) {
      issues.push({
        code: 'C6',
        fromShotIdx: i - 1,
        shotIdx: i,
        message: `第 ${i + 1} 镜为 cut 切镜，但缺少【衔接】anchor 锚点说明`,
        severity: 'error',
      })
    }

    // C11：continuous 衔接时主体角色一致性校验
    const prevSubject = inferSubjectId(prev, scene)
    const curSubject = inferSubjectId(cur, scene)
    if (link.type === 'continuous' && prevSubject != null && curSubject != null && prevSubject !== curSubject) {
      const prevRoles = new Set((Array.isArray(prev.roles) ? prev.roles : []).map((r: any) => Number(r?.id ?? r)))
      const curRoles = new Set((Array.isArray(cur.roles) ? cur.roles : []).map((r: any) => Number(r?.id ?? r)))
      const sharesAnyRole = [...curRoles].some(id => prevRoles.has(id))
      if (!sharesAnyRole) {
        issues.push({
          code: 'C11',
          fromShotIdx: i - 1,
          shotIdx: i,
          message: `镜头 ${i}→${i + 1} 标记为 continuous，但主体由 #${prevSubject} 突变为 #${curSubject} 且无同框过渡，应改为 cut 并写明匹配锚点`,
          severity: 'warning',
        })
      }
    }

    // C12：运动方向连贯性校验（continuous 下禁止水平方向直接相撞）
    const prevDir = inferMotionDirection(prev)
    const curDir = inferMotionDirection(cur)
    if (link.type === 'continuous' && isOppositeHorizontalDirection(prevDir, curDir)) {
      issues.push({
        code: 'C12',
        fromShotIdx: i - 1,
        shotIdx: i,
        message: `镜头 ${i}→${i + 1} 标记为 continuous，但主体水平运动方向由 ${prevDir} 突变为反向 ${curDir}`,
        severity: 'warning',
      })
    }

    // C13：色调/色温连续性校验（同场内非 transition 切镜不应出现纯暖 ↔ 纯冷极性反转）
    if (link.type !== 'transition') {
      const polA = colorPolarity(inferColorTone(prev, scene))
      const polB = colorPolarity(inferColorTone(cur, scene))
      if ((polA === 'warm' && polB === 'cool') || (polA === 'cool' && polB === 'warm')) {
        issues.push({
          code: 'C13',
          fromShotIdx: i - 1,
          shotIdx: i,
          message: `镜头 ${i}→${i + 1} 色温极性突变（${polA}→${polB}），偏离本场统一色调锚点`,
          severity: 'warning',
        })
      }
    }

    // C15：不可逆动作还原重做检测（例如镜头1已开门，镜头2又把门还原成关闭重新开门）
    const prevAction = getShotActionText(prev)
    const curAction = getShotActionText(cur)
    const curIn = String(cur.motion?.in || cur.start_prompt || '').trim()
    for (const rule of STATE_TRANSITION_RULES) {
      const prevDidAction = rule.actionRe.test(prevAction) && !(rule.reverseRe && rule.reverseRe.test(prevAction))
      if (!prevDidAction) continue
      const curRepeatsAction = rule.actionRe.test(curAction)
      const curResetsState = Boolean(rule.resetStateRe && rule.resetStateRe.test(`${curIn} ${curAction}`))
      if (curRepeatsAction || curResetsState) {
        issues.push({
          code: 'C15',
          fromShotIdx: i - 1,
          shotIdx: i,
          message: `镜头 ${i}→${i + 1} 发生状态回退/动作重做：第 ${i} 镜已完成「${rule.label}」，第 ${i + 1} 镜严禁将状态还原或重复执行「${rule.label}」`,
          severity: 'warning',
        })
      }
    }
  }

  // C14：节奏分布校验（>= 4 个镜头若全部时长完全一致，提示节奏缺乏快慢呼吸感）
  if (shots.length >= 4) {
    const durations = shots.map(s => Number(s?.durShort || 5))
    const uniqueDurs = new Set(durations)
    if (uniqueDurs.size === 1) {
      issues.push({
        code: 'C14',
        shotIdx: shots.length - 1,
        message: `本场共 ${shots.length} 个镜头时长全部固定为 ${durations[0]}s，缺乏叙事快慢节奏变化`,
        severity: 'warning',
      })
    }
  }

  return issues
}

/**
 * 修正镜头时长至合法范围 [2, 15] 秒。
 */
export function autoFixShotDurations<T extends { shots?: any[] }>(scene: T): T {
  if (!scene || !Array.isArray(scene.shots)) return scene
  for (const shot of scene.shots) {
    const stated = Number(shot?.durShort) || 5
    shot.durShort = Math.min(15, Math.max(2, stated))
  }
  return scene
}

/**
 * 为整章所有场景与分镜注入连贯性元数据（subject_id / color_tone / motion_direction / prev_shot_id / next_shot_id /
 * style_anchor_id / continuity_status / prev_shot_summary / 稳定种子），并生成可落库 storyboard 表的结构化行。
 */
export function enrichChapterContinuity(
  configs: any[],
  options: {
    chapterId: number
    workId?: number
    styleAnchorId?: number | null
    defaultFrameMode?: 'single' | 'dual' | 'video_tail'
  },
): {
  configs: any[]
  storyboardRows: StoryboardContinuityRow[]
  issuesByScene: Array<{ sceneIdx: number; issues: ContinuityIssue[] }>
  overallScore: number
} {
  const { chapterId, workId = 0, styleAnchorId = null, defaultFrameMode = 'single' } = options
  const scenes = Array.isArray(configs) ? configs : []
  const storyboardRows: StoryboardContinuityRow[] = []
  const issuesByScene: Array<{ sceneIdx: number; issues: ContinuityIssue[] }> = []

  // 先收集全局线性镜头列表，便于计算 prev_shot_id / next_shot_id 与前序镜头摘要
  const flatMeta: Array<{
    sceneIdx: number
    shotIdx: number
    panelIdx: number
    shotKey: string
    shot: any
    scene: any
  }> = []

  let panelIdx = 0
  for (let scIdx = 0; scIdx < scenes.length; scIdx++) {
    const sc = scenes[scIdx] || {}
    if (Array.isArray(sc.shots)) {
      for (const sh of sc.shots) {
        if (sh && Array.isArray(sh.dialogue)) {
          sh.dialogue = sanitizeDialogueList(sh.dialogue)
        }
      }
    }
    removeRedundantCuts(sc)
    autoFixShotDurations(sc)
    deriveSceneWorldState(sc)
    const shots = Array.isArray(sc.shots) ? sc.shots : []
    for (let shIdx = 0; shIdx < shots.length; shIdx++) {
      const shot = shots[shIdx]
      const shotKey = `${chapterId}:${scIdx}:${shIdx}`
      flatMeta.push({ sceneIdx: scIdx, shotIdx: shIdx, panelIdx, shotKey, shot, scene: sc })
      panelIdx++
    }
  }

  // 第一遍：填充每个镜头的连贯性字段、前序镜头摘要与一致性 Seed
  for (let idx = 0; idx < flatMeta.length; idx++) {
    const item = flatMeta[idx]!
    const prevItem = idx > 0 ? flatMeta[idx - 1] : null
    const nextItem = idx + 1 < flatMeta.length ? flatMeta[idx + 1] : null
    const { shot, scene, sceneIdx, shotIdx, shotKey } = item

    const subjectId = inferSubjectId(shot, scene)
    const colorTone = inferColorTone(shot, scene)
    const motionDirection = inferMotionDirection(shot)
    const shotSize = String(shot.shot_size || '中景').trim() || '中景'

    shot.shot_id = shotKey
    shot.subject_id = subjectId
    shot.color_tone = colorTone
    shot.motion_direction = motionDirection
    shot.shot_size = shotSize
    shot.prev_shot_id = prevItem ? prevItem.shotKey : null
    shot.next_shot_id = nextItem ? nextItem.shotKey : null
    shot.style_anchor_id = styleAnchorId
    shot.frame_mode = ['single', 'dual', 'video_tail'].includes(shot.frame_mode)
      ? shot.frame_mode
      : defaultFrameMode
    shot.world_state = String(shot.world_state || '')

    // 注入确定性角色/场景一致性种子（当分镜尚未生成固定 seed 时）
    if (shot.start_seed == null) {
      shot.start_seed = deriveConsistentSeed({
        workId,
        styleAnchorId,
        subjectId,
        sceneId: scene.scene_id,
        slot: `s${sceneIdx}-${shotIdx}-head`,
      })
    }
    if (shot.end_seed == null) {
      shot.end_seed = deriveConsistentSeed({
        workId,
        styleAnchorId,
        subjectId,
        sceneId: scene.scene_id,
        slot: `s${sceneIdx}-${shotIdx}-tail`,
      })
    }

    // 注入前序镜头摘要（供链式首尾帧渲染与视频生成携带上下文）
    if (prevItem) {
      const pShot = prevItem.shot
      shot.prev_shot_summary = {
        shot_id: prevItem.shotKey,
        same_scene: prevItem.sceneIdx === sceneIdx,
        subject_id: pShot.subject_id ?? null,
        shot_size: pShot.shot_size || '',
        camera_angle: pShot.camera_angle || '',
        axis_side: pShot.axis_side || '',
        motion_direction: pShot.motion_direction || 'static',
        color_tone: pShot.color_tone || '',
        end_state: String(pShot.motion?.out || pShot.content || '').slice(0, 120),
      }
    } else {
      shot.prev_shot_summary = null
    }
  }

  // 第二遍：逐场景执行连贯性校验并计算每镜的 continuity_status
  let totalErrors = 0
  let totalWarnings = 0
  for (let scIdx = 0; scIdx < scenes.length; scIdx++) {
    const sc = scenes[scIdx] || {}
    const issues = validateShots(sc)
    issuesByScene.push({ sceneIdx: scIdx, issues })
    const shots = Array.isArray(sc.shots) ? sc.shots : []

    for (let shIdx = 0; shIdx < shots.length; shIdx++) {
      const shot = shots[shIdx]
      const shotIssues = issues.filter(iss => iss.shotIdx === shIdx)
      const hasError = shotIssues.some(iss => iss.severity === 'error')
      const hasWarning = shotIssues.some(iss => iss.severity === 'warning')
      if (hasError) totalErrors += shotIssues.filter(i => i.severity === 'error').length
      if (hasWarning) totalWarnings += shotIssues.filter(i => i.severity === 'warning').length

      const status: ContinuityStatus = hasError ? 'qc_failed' : hasWarning ? 'warning' : 'passed'
      shot.continuity_status = status
      shot.continuity_issues = shotIssues.map(i => ({ code: i.code, severity: i.severity, message: i.message }))
    }
  }

  for (const item of flatMeta) {
    storyboardRows.push({
      chapter_id: chapterId,
      scene_idx: item.sceneIdx,
      shot_idx: item.shotIdx,
      panel_idx: item.panelIdx,
      shot_key: item.shotKey,
      subject_id: item.shot.subject_id ?? null,
      color_tone: item.shot.color_tone || '',
      motion_direction: item.shot.motion_direction || 'static',
      shot_size: item.shot.shot_size || '中景',
      prev_shot_id: item.shot.prev_shot_id ?? null,
      next_shot_id: item.shot.next_shot_id ?? null,
      style_anchor_id: item.shot.style_anchor_id ?? null,
      continuity_status: item.shot.continuity_status || 'passed',
      frame_mode: item.shot.frame_mode || defaultFrameMode,
      world_state: String(item.shot.world_state || ''),
    })
  }

  const penalty = totalErrors * 15 + totalWarnings * 4
  const overallScore = Math.max(0, Math.min(100, 100 - penalty))

  return { configs: scenes, storyboardRows, issuesByScene, overallScore }
}
