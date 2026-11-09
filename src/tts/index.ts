import { uploadHexAudioToOSS } from '../config/oss.config'

const BASE_URL = process.env.TTS_API_URL || ''
const API_KEY = process.env.TTS_API_KEY || ''
/** 单次 TTS 请求超时：配音是整条视频流水线的一步，不能无限挂起 */
const TTS_TIMEOUT_MS = 120_000

export interface TTSResult {
  success: boolean
  voiceUrl: string
  /** 音频时长（秒） */
  duration: number
  error?: string
}

export interface TTSParams {
  model?: string
  text: string
  voice_id: string
  emotion?: string
  tone?: string
  speed?: number
}

const defaultTTSParams: TTSParams = {
  model: 'speech-2.8-hd',
  text: '',
  voice_id: '',
  emotion: '',
}

/**
 * 根据分镜台词的 tone（语气词）微调语速，使急促喘息/嘶吼与低声呢喃/沙哑更具戏剧张力。
 */
export function resolveTtsSpeed(tone?: string, explicitSpeed?: number): number | undefined {
  if (explicitSpeed != null && Number.isFinite(explicitSpeed)) {
    return Math.max(0.5, Math.min(2.0, Number(explicitSpeed.toFixed(2))))
  }
  const t = String(tone || '').trim()
  if (!t) return undefined
  if (/喘气|急促|嘶吼|厉喝|厉声|高声|咆哮|惊呼|失声/.test(t)) return 1.06
  if (/低声|喃喃|气声|沙哑|嘶哑|低缓|哽咽|颤抖|叹息|呢喃|轻声|沉声|压着嗓子|懒懒/.test(t)) return 0.94
  return undefined
}

export async function generateTTS(params: TTSParams = defaultTTSParams): Promise<TTSResult> {
  if (!BASE_URL || !API_KEY) {
    return { success: false, error: '缺少 TTS_API_URL 或 TTS_API_KEY 环境变量', voiceUrl: '', duration: 0 }
  }
  try {
    const url = `${BASE_URL.replace(/\/+$/, '')}/t2a_v2`
    const speed = resolveTtsSpeed(params.tone, params.speed)
    const body = {
      model: params.model || 'speech-2.8-hd',
      text: params.text,
      stream: false,
      voice_setting: {
        voice_id: params.voice_id,
        ...(params.emotion ? { emotion: params.emotion } : {}), // 控制合成语音的情绪
        ...(speed != null ? { speed } : {}),
      },
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    })

    // 必须按 res.ok 判断：statusText 在 HTTP/2 下恒为空字符串，
    // 用它会把成功响应误判为失败，也会让 4xx/5xx 溜到下面的 JSON 解析里。
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return {
        success: false,
        error: `TTS API 错误 ${res.status}: ${errText.slice(0, 300)}`,
        voiceUrl: '',
        duration: 0,
      }
    }

    const data: any = await res.json().catch(() => null)
    const hexAudio: string = data?.data?.audio || ''
    if (!hexAudio) {
      return { success: false, error: `TTS API 返回了数据但没有音频：${JSON.stringify(data).slice(0, 200)}`, voiceUrl: '', duration: 0 }
    }

    const format: string = data?.extra_info?.audio_format || 'mp3'
    const rawAudioLength = Number(data?.extra_info?.audio_length || 0)
    // MiniMax t2a_v2 返回的 extra_info.audio_length 单位为毫秒（ms），统一转换为秒（s）
    const durationSec = rawAudioLength > 100
      ? Number((rawAudioLength / 1000).toFixed(2))
      : rawAudioLength

    const ossUrl = await uploadHexAudioToOSS(hexAudio, format, 'tts')

    return { success: true, voiceUrl: ossUrl, duration: durationSec }
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return {
      success: false,
      error: timedOut ? `TTS 请求超时（${Math.round(TTS_TIMEOUT_MS / 1000)}s）` : (e?.message || '网络请求失败'),
      voiceUrl: '',
      duration: 0,
    }
  }
}
