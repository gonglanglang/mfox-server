import { generateTTS } from '../../tts/index'
import { sanitizeDialogueList } from '../../tools/storyboard-text'
import {
  recordShotAssetVersion,
  selectShotAssetVersion,
  type ShotAssetRecord,
} from '../shot-assets-store'

export interface AudioNodeInput {
  chapterId: number
  sceneIndex: number
  shotIndex: number
  shot?: Record<string, any>
  text?: string
  voiceId?: string
  emotion?: string
  tone?: string
  modelKey?: string
  generator?: (params: {
    text: string
    voiceId: string
    emotion?: string
    tone?: string
    modelKey?: string
  }) => Promise<{ url: string; duration?: number }>
}

export interface AudioNodeOutput {
  nodeType: 'audio'
  chapterId: number
  sceneIndex: number
  shotIndex: number
  assetType: 'tts'
  url: string
  duration: number
  version: number
  asset: ShotAssetRecord
}

/**
 * 独立音频生成节点（AudioGenNode）：
 * - 为单个镜头生成 TTS 配音，写入 shot_assets 新版本并置为 is_current=1
 */
export async function executeAudioNode(input: AudioNodeInput): Promise<AudioNodeOutput> {
  const shot = input.shot || {}
  const dialogue = sanitizeDialogueList(Array.isArray(shot.dialogue) ? shot.dialogue : [])
  const primaryLine = dialogue[0]

  const text = String(input.text ?? primaryLine?.text ?? '').trim()
  if (!text) {
    throw new Error(`镜头 (${input.sceneIndex + 1}-${input.shotIndex + 1}) 没有可合成的台词文本`)
  }
  const voiceId = String(input.voiceId || primaryLine?.voiceId || 'male-qn-qingse').trim()
  const emotion = String(input.emotion || primaryLine?.emotion || 'calm').trim()
  const tone = String(input.tone || primaryLine?.tone || '').trim()
  const modelKey = input.modelKey || 'speech-2.8-hd'

  let url = ''
  let duration = 0
  if (input.generator) {
    const res = await input.generator({ text, voiceId, emotion, tone, modelKey })
    url = res.url
    duration = res.duration || 0
  } else {
    const res = await generateTTS({
      model: modelKey,
      text,
      voice_id: voiceId,
      emotion,
      tone,
    })
    if (!res.success || !res.voiceUrl) {
      throw new Error(res.error || 'TTS 音频节点生成失败')
    }
    url = res.voiceUrl
    duration = res.duration || 0
  }

  const asset = await recordShotAssetVersion({
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType: 'tts',
    url,
    prompt: text,
    modelKey,
    duration,
    params: { voiceId, emotion, tone },
    status: 'done',
  })

  await selectShotAssetVersion({
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType: 'tts',
    version: asset.version,
  }).catch(() => {})

  return {
    nodeType: 'audio',
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType: 'tts',
    url,
    duration,
    version: asset.version,
    asset,
  }
}
