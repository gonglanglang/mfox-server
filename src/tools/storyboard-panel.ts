import { shotFrameUrl } from './frame-pool'
import { sanitizeDialogueList } from './storyboard-text'

/**
 * 镜头时长（秒）：AI 给出的值优先，否则按台词字数推算。
 * 配音长度由台词字数决定，镜头时长必须能容纳台词——不足时抬高到所需值，
 * 避免"视频 5 秒、配音 8 秒"的音画不齐。上限 60 秒，与后台可编辑范围一致。
 */
function resolveShotDuration(shot: any, segments: { text?: string }[]): number {
  const stated = Number(shot?.durShort)
  const base = Number.isInteger(stated) && stated >= 1 ? stated : 5
  const chars = segments.reduce((sum, segment) => sum + String(segment?.text || '').length, 0)
  // 约 4.5 字 1 秒，最低 3 秒（给动作与停顿留余量）
  const needed = chars > 0 ? Math.max(3, Math.ceil(chars / 4.5)) : 0
  return Math.min(15, Math.max(3, Math.max(base, needed)))
}

/**
 * Resolve a production panel without flattening the persisted scene/shot tree.
 *
 * 关键帧：shot 只存 start_frame_id / end_frame_id 引用，图片本体在场景的 _frames 池里
 * （tools/frame-pool.ts）。这里把引用解析成派生的 firstFrameUrl / lastFrameUrl，
 * 让所有读取方（前端、视频链路、链式校验）无需感知帧池；派生字段不回写落库。
 */
export function resolveStoryboardPanel(configs: any[], panelIdx: number) {
  if (!Number.isSafeInteger(panelIdx) || panelIdx < 0) return undefined
  let flatIndex = 0
  for (let sceneIdx = 0; sceneIdx < configs.length; sceneIdx++) {
    const scene = configs[sceneIdx]
    if (!Array.isArray(scene?.shots)) {
      const index = flatIndex++
      if ((scene?.panelIdx ?? index) === panelIdx) {
        // 旧扁平结构没有场景概念，也没有帧池：内联字段即真源。
        return { panel: scene, sceneIdx: undefined, scene, shot: scene, commit() {} }
      }
      continue
    }
    for (const shot of scene.shots) {
      if (flatIndex++ !== panelIdx) continue
      const cleanDialogue = sanitizeDialogueList(shot.dialogue || [])
      const segments = cleanDialogue.map((line: any) => {
        const roleId = line.id === '' || line.id == null ? undefined : Number(line.id)
        const type = line.speaker?.trim() === '旁白' || !roleId ? 'narration' : 'dialogue'
        // segments 完全由 dialogue 派生：audioUrl 也存在 dialogue 上（TTS 产出），不再单独落库
        return {
          type,
          role_id: roleId,
          text: line.text || '',
          speaker: line.speaker,
          tone: line.tone,
          emotion: line.emotion,
          ...(line.audioUrl ? { audioUrl: line.audioUrl } : {}),
        }
      })
      const panel = {
        ...shot,
        panelIdx,
        dialogue: cleanDialogue,
        // Existing generation prompts consume environment; include both scene atmosphere and shot action.
        environment: [scene.environment, shot.content].filter(Boolean).join('\n'),
        scene_id: scene.scene_id == null ? null : Number(scene.scene_id),
        prop_ids: (scene.prop_ids || []).map(Number),
        segments,
        roles: Array.isArray(shot.roles)
          ? shot.roles.map((role: any) => ({ ...role, id: Number(role.id) }))
          : [...new Set(segments.filter((s: any) => s.type === 'dialogue').map((s: any) => s.role_id).filter(Boolean))].map(id => ({ id })),
        durShort: resolveShotDuration(shot, segments),
        // 关键帧 URL 由帧池引用派生（旧数据回退到内联字段）
        firstFrameUrl: shotFrameUrl(scene, shot, 'start'),
        lastFrameUrl: shotFrameUrl(scene, shot, 'end'),
      }
      return {
        panel,
        sceneIdx,
        scene,
        shot,
        commit() {
          // These values are inherited/derived for generation, not fields of a stored shot.
          // segments 亦然：它由 dialogue 现组装，落库会与 dialogue 重复。
          // firstFrameUrl / lastFrameUrl 是帧池引用的派生视图，真源是 start_frame_id / end_frame_id。
          const {
            panelIdx: _index,
            environment: _environment,
            scene_id: _scene,
            prop_ids: _props,
            segments: _segments,
            firstFrameUrl: _first,
            lastFrameUrl: _last,
            ...updated
          } = panel
          Object.assign(shot, updated)
        },
      }
    }
  }
  return undefined
}
