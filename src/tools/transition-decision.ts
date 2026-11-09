import { normalizeShotLink } from './storyboard-text'
import { pool } from '../mysqlDb'
import type { StoryboardContinuityRow } from './shot-continuity'

export interface TransitionDecisionRow {
  chapter_id: number
  from_shot: string
  to_shot: string
  type: string
  duration: number
  reason: string
}

export interface TransitionDecisionOptions {
  chapterId: number
  /** 转场总时长占全片总时长的最大比例上限（默认 0.12，即 12%） */
  maxTransitionRatio?: number
}

const MAJOR_TIME_JUMP_RE = /次日|翌日|清晨|黎明|深夜|子夜|数日|三日|半月|昏迷|醒来|苏醒|多年后/

/**
 * 智能转场决策器（需求 3.1 / 3.2 / 3.3 / 4）：
 * - 同场景 continuous：0s 硬切（共享首尾帧无缝顺接，禁止无差别加叠化导致重影）
 * - 同场景 cut：按 match 类型选择 0s 硬切（eyeline/action）或 ≤0.3s 微软切叠化（graphic/情绪慢镜）
 * - 同场景 transition：固定 ≤0.3s 软切/叠化
 * - 跨场景：按前后场时空跨度、动作衔接、先声夺人特征智能选择 黑场(0.6s) / 叠化(0.45s) / 声音先入(0.4s) / 动作匹配转场(0.25s)
 * - 全局约束：转场总时长占比不超过 maxTransitionRatio（默认 12%），超限时自动消减次要转场
 */
export function decideShotTransitions(
  configs: any[],
  options: TransitionDecisionOptions,
): TransitionDecisionRow[] {
  const { chapterId, maxTransitionRatio = 0.12 } = options
  const scenes = Array.isArray(configs) ? configs : []

  const flatShots: Array<{
    sceneIdx: number
    shotIdx: number
    shotKey: string
    shot: any
    scene: any
  }> = []

  for (let scIdx = 0; scIdx < scenes.length; scIdx++) {
    const sc = scenes[scIdx] || {}
    const shots = Array.isArray(sc.shots) ? sc.shots : []
    for (let shIdx = 0; shIdx < shots.length; shIdx++) {
      const shot = shots[shIdx]
      const shotKey = String(shot?.shot_id || `${chapterId}:${scIdx}:${shIdx}`)
      flatShots.push({ sceneIdx: scIdx, shotIdx: shIdx, shotKey, shot, scene: sc })
    }
  }

  if (flatShots.length <= 1) return []

  const rawDecisions: Array<TransitionDecisionRow & { priority: number; fromRef: any }> = []

  for (let i = 0; i < flatShots.length - 1; i++) {
    const cur = flatShots[i]!
    const next = flatShots[i + 1]!
    const sameScene = cur.sceneIdx === next.sceneIdx
    const nextLink = normalizeShotLink(next.shot)
    const explicitShotTrans = String(cur.shot.transition_out || cur.shot.transition || '').trim()
    const explicitManual = Boolean(cur.shot.manual_transition_override)

    let type = '硬切'
    let duration = 0
    let reason = ''
    let priority = 1 // 1=可优先降级(同场景微转场) 2=跨场景常规转场 3=手动指定或强叙事转场

    if (explicitManual && explicitShotTrans) {
      type = explicitShotTrans
      duration = type === '硬切' ? 0 : Number(cur.shot.transition_duration) || (sameScene ? 0.25 : 0.45)
      if (sameScene && duration > 0.3) duration = 0.3
      reason = `人工手动锁定转场：${type}（${duration}s）`
      priority = 3
    } else if (sameScene) {
      // 同场景转场决策：严格限制 ≤ 0.3s
      if (nextLink.type === 'continuous') {
        type = '硬切'
        duration = 0
        reason = '同场景 continuous 连续镜头（共享交界帧），采用 0s 无缝直切避免叠化重影'
        priority = 3
      } else if (nextLink.type === 'transition') {
        type = explicitShotTrans && explicitShotTrans !== '硬切' ? explicitShotTrans : '叠化'
        duration = 0.30
        reason = `同场景时空微跳切（${nextLink.anchor || '短时间过渡'}），采用 0.30s 软切叠化（≤0.3s 规范）`
        priority = 2
      } else {
        // nextLink.type === 'cut'
        if (nextLink.match === 'action') {
          type = '动作匹配转场'
          duration = 0
          reason = `同场景动作顺接匹配剪辑（${nextLink.anchor || 'Match on Action'}），0s 硬切保持动作势能`
          priority = 2
        } else if (nextLink.match === 'eyeline') {
          type = '硬切'
          duration = 0
          reason = `同场景视线匹配正反打（${nextLink.anchor || 'Eyeline Match'}），0s 硬切保持对话紧凑感`
          priority = 2
        } else if (nextLink.match === 'sound') {
          type = '声音先入'
          duration = 0.20
          reason = `同场景声音引导切镜（${nextLink.anchor || 'Sound Bridge'}），0.20s 软切过渡（≤0.3s 规范）`
          priority = 1
        } else if (nextLink.match === 'graphic' || Number(cur.shot.durShort || 4) >= 6) {
          type = '叠化'
          duration = 0.25
          reason = `同场景构图/抒情慢镜过渡（${nextLink.anchor || 'Graphic Match'}），0.25s 软叠化（≤0.3s 规范）`
          priority = 1
        } else {
          type = '硬切'
          duration = 0
          reason = `同场景标准切镜（${nextLink.anchor || '叙事切镜'}），0s 硬切干脆利落`
          priority = 2
        }
      }
    } else {
      // 跨场景转场决策
      const sceneTrans = String(cur.scene?.transition || '').trim()
      const nextEnv = String(next.scene?.environment || '')
      const nextFirstText = String(next.shot?.content || '')
      const hasMajorTimeJump = MAJOR_TIME_JUMP_RE.test(nextEnv) || MAJOR_TIME_JUMP_RE.test(nextFirstText)

      if (nextLink.match === 'action' || sceneTrans === '动作匹配转场') {
        type = '动作匹配转场'
        duration = 0.25
        reason = '跨场景动作匹配剪辑，顺接上一场末尾主体动作方向'
        priority = 2
      } else if (hasMajorTimeJump || sceneTrans === '黑场' || sceneTrans === '淡入淡出') {
        type = sceneTrans === '淡入淡出' ? '淡入淡出' : '黑场'
        duration = 0.55
        reason = '跨场景存在明显昼夜/时空跨度，采用 0.55s 黑场/淡入淡出留白过渡'
        priority = 3
      } else if (sceneTrans === '闪白') {
        type = '闪白'
        duration = 0.30
        reason = '跨场景视觉冲击/回忆切入，采用 0.30s 闪白过渡'
        priority = 2
      } else if (sceneTrans === '声音先入' || nextLink.match === 'sound') {
        type = '声音先入'
        duration = 0.35
        reason = '跨场景声音先入（J-Cut），新场环境音/台词提前 0.35s 切入'
        priority = 2
      } else {
        type = sceneTrans && sceneTrans !== '硬切' ? sceneTrans : '叠化'
        duration = 0.45
        reason = '跨场景空间转换，采用 0.45s 叠化平滑过渡'
        priority = 2
      }
    }

    rawDecisions.push({
      chapter_id: chapterId,
      from_shot: cur.shotKey,
      to_shot: next.shotKey,
      type,
      duration: Number(duration.toFixed(2)),
      reason,
      priority,
      fromRef: cur.shot,
    })
  }

  // 全局约束检查：转场总时长占比不得超过 maxTransitionRatio（默认 12%）
  const totalVideoSec = flatShots.reduce((sum, s) => sum + Math.max(2, Number(s.shot?.durShort || 4)), 0)
  const maxAllowedTransitionSec = Math.max(0.5, totalVideoSec * maxTransitionRatio)
  let currentTransitionSec = rawDecisions.reduce((sum, d) => sum + d.duration, 0)

  if (currentTransitionSec > maxAllowedTransitionSec) {
    // 先把 priority === 1 的同场景次要微叠化降为 0s 硬切
    for (const d of rawDecisions) {
      if (currentTransitionSec <= maxAllowedTransitionSec) break
      if (d.priority === 1 && d.duration > 0) {
        currentTransitionSec -= d.duration
        d.duration = 0
        d.type = '硬切'
        d.reason += '（因全片转场时长占比超限，自动收紧为 0s 硬切）'
      }
    }
    // 若仍超限，按比例压缩其余非手动转场时长
    if (currentTransitionSec > maxAllowedTransitionSec && currentTransitionSec > 0) {
      const scale = maxAllowedTransitionSec / currentTransitionSec
      for (const d of rawDecisions) {
        if (d.duration > 0 && d.priority < 3) {
          d.duration = Number(Math.max(0.15, d.duration * scale).toFixed(2))
        }
      }
    }
  }

  // 写回每个镜头的 transition_out / transition_duration / transition_reason
  return rawDecisions.map(({ priority: _p, fromRef, ...row }) => {
    fromRef.transition_out = row.type
    fromRef.transition = row.type
    fromRef.transition_duration = row.duration
    fromRef.transition_reason = row.reason
    return row
  })
}

/**
 * 将章节的分镜连贯性元数据（storyboard 表）与转场决策（transition_decision 表）幂等同步到数据库。
 */
export async function syncContinuityAndTransitionsToDb(
  chapterId: number,
  storyboardRows: StoryboardContinuityRow[],
  transitionRows: TransitionDecisionRow[],
): Promise<void> {
  if (!Number.isSafeInteger(chapterId) || chapterId <= 0) return
  const now = new Date()

  for (const row of storyboardRows) {
    await pool.query(
      `INSERT INTO \`storyboard\`
       (\`chapter_id\`, \`scene_idx\`, \`shot_idx\`, \`panel_idx\`, \`shot_key\`, \`subject_id\`, \`color_tone\`,
        \`motion_direction\`, \`shot_size\`, \`prev_shot_id\`, \`next_shot_id\`, \`style_anchor_id\`, \`continuity_status\`,
        \`frame_mode\`, \`world_state\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         \`scene_idx\` = VALUES(\`scene_idx\`),
         \`shot_idx\` = VALUES(\`shot_idx\`),
         \`panel_idx\` = VALUES(\`panel_idx\`),
         \`subject_id\` = VALUES(\`subject_id\`),
         \`color_tone\` = VALUES(\`color_tone\`),
         \`motion_direction\` = VALUES(\`motion_direction\`),
         \`shot_size\` = VALUES(\`shot_size\`),
         \`prev_shot_id\` = VALUES(\`prev_shot_id\`),
         \`next_shot_id\` = VALUES(\`next_shot_id\`),
         \`style_anchor_id\` = VALUES(\`style_anchor_id\`),
         \`continuity_status\` = VALUES(\`continuity_status\`),
         \`frame_mode\` = VALUES(\`frame_mode\`),
         \`world_state\` = VALUES(\`world_state\`),
         \`updated_at\` = VALUES(\`updated_at\`)`,
      [
        row.chapter_id,
        row.scene_idx,
        row.shot_idx,
        row.panel_idx,
        row.shot_key,
        row.subject_id,
        row.color_tone,
        row.motion_direction,
        row.shot_size,
        row.prev_shot_id,
        row.next_shot_id,
        row.style_anchor_id,
        row.continuity_status,
        row.frame_mode || 'single',
        String(row.world_state || '').slice(0, 500),
        now,
        now,
      ],
    )
  }

  for (const tr of transitionRows) {
    await pool.query(
      `INSERT INTO \`transition_decision\`
       (\`chapter_id\`, \`from_shot\`, \`to_shot\`, \`type\`, \`duration\`, \`reason\`, \`created_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         \`type\` = VALUES(\`type\`),
         \`duration\` = VALUES(\`duration\`),
         \`reason\` = VALUES(\`reason\`)`,
      [
        tr.chapter_id,
        tr.from_shot,
        tr.to_shot,
        tr.type,
        tr.duration,
        tr.reason,
        now,
      ],
    )
  }
}
