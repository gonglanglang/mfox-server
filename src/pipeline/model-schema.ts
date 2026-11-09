import { parseGenMode, resolveShotImagePrompt, resolveShotMotionPrompt, type VideoGenMode } from '../tools/storyboard-text'

export type VideoMode = VideoGenMode

export interface ModelCapability {
  modes: VideoMode[]
  params: {
    duration: number[]
    resolution: string[]
    aspectRatio: string[]
    fps?: number[]
  }
  inputLimits: {
    maxImages: number
    maxVideos: number
    maxAudios: number
    requireFirstFrame?: boolean
    requireLastFrame?: boolean
  }
}

export interface CollectedMediaItem {
  type: 'first_frame' | 'last_frame' | 'image' | 'video' | 'audio'
  url: string
  role?: string
}

export interface CollectedShotInputs {
  mode: VideoMode
  prompt: string
  imagePrompt: string
  motionPrompt: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls: string[]
  referenceVideoUrls: string[]
  audioUrls: string[]
  media: CollectedMediaItem[]
}

export const ALL_VIDEO_MODES: VideoMode[] = [
  'text2video',
  'singleImage2video',
  'frames2video',
  'image2video',
  'video2video',
  'videoEdit2video',
  'audio2video',
  'mixed2video',
]

export const VIDEO_MODE_LABELS: Record<VideoMode, string> = {
  text2video: '文生视频 (text2video)',
  singleImage2video: '单图生视频 (singleImage2video)',
  frames2video: '首尾帧生视频 (frames2video)',
  image2video: '多图参考生视频 (image2video)',
  video2video: '视频参考生视频 (video2video)',
  videoEdit2video: '视频编辑 (videoEdit2video)',
  audio2video: '音频驱动生视频 (audio2video)',
  mixed2video: '全模态参考生视频 (mixed2video)',
}

const DEFAULT_CAPABILITY: ModelCapability = {
  modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video'],
  params: {
    duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolution: ['720p', '1080p'],
    aspectRatio: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    fps: [24, 30],
  },
  inputLimits: {
    maxImages: 4,
    maxVideos: 1,
    maxAudios: 1,
  },
}

const PRESET_CAPABILITIES: { match: RegExp; capability: ModelCapability }[] = [
  {
    match: /seedance[-_ ]?2|doubao[-_ ]?seedance[-_ ]?2|omni/i,
    capability: {
      modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video', 'video2video', 'audio2video', 'mixed2video'],
      params: {
        duration: [3, 4, 5, 6, 7, 8, 9, 10, 12, 15],
        resolution: ['720p', '1080p'],
        aspectRatio: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
        fps: [24],
      },
      inputLimits: {
        maxImages: 9,
        maxVideos: 3,
        maxAudios: 3,
      },
    },
  },
  {
    match: /seedance|doubao/i,
    capability: {
      modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video'],
      params: {
        duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        resolution: ['480p', '720p', '1080p'],
        aspectRatio: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
        fps: [24],
      },
      inputLimits: {
        maxImages: 4,
        maxVideos: 0,
        maxAudios: 0,
      },
    },
  },
  {
    match: /veo[-_ ]?3|veo3/i,
    capability: {
      modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video'],
      params: {
        duration: [4, 6, 8],
        resolution: ['720p', '1080p'],
        aspectRatio: ['16:9', '9:16'],
        fps: [24],
      },
      inputLimits: {
        maxImages: 3,
        maxVideos: 0,
        maxAudios: 0,
      },
    },
  },
  {
    match: /kling|可灵/i,
    capability: {
      modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video', 'videoEdit2video'],
      params: {
        duration: [5, 10],
        resolution: ['720p', '1080p'],
        aspectRatio: ['16:9', '9:16', '1:1'],
        fps: [24, 30],
      },
      inputLimits: {
        maxImages: 4,
        maxVideos: 1,
        maxAudios: 1,
      },
    },
  },
  {
    match: /wan[-_ ]?2|通义万相|wanx/i,
    capability: {
      modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video', 'audio2video'],
      params: {
        duration: [3, 4, 5, 6, 8, 10],
        resolution: ['720p', '1080p'],
        aspectRatio: ['16:9', '9:16', '1:1'],
        fps: [24],
      },
      inputLimits: {
        maxImages: 3,
        maxVideos: 1,
        maxAudios: 1,
      },
    },
  },
  {
    match: /vidu/i,
    capability: {
      modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video'],
      params: {
        duration: [4, 5, 8],
        resolution: ['720p', '1080p'],
        aspectRatio: ['16:9', '9:16', '1:1'],
        fps: [24],
      },
      inputLimits: {
        maxImages: 7,
        maxVideos: 0,
        maxAudios: 0,
      },
    },
  },
  {
    match: /hailuo|minimax|海螺/i,
    capability: {
      modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video'],
      params: {
        duration: [5, 6, 10],
        resolution: ['720p', '1080p'],
        aspectRatio: ['16:9', '9:16', '1:1'],
        fps: [24, 25],
      },
      inputLimits: {
        maxImages: 3,
        maxVideos: 0,
        maxAudios: 0,
      },
    },
  },
]

function normalizeRawCapability(raw: any, base: ModelCapability): ModelCapability {
  if (!raw || typeof raw !== 'object') return base
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return base
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base

  const rawModes: VideoMode[] = Array.isArray(parsed.modes)
    ? (parsed.modes as unknown[]).map((m: unknown) => parseGenMode(m)).filter((m): m is VideoMode => Boolean(m))
    : []
  const modes: VideoMode[] = rawModes.length > 0 ? Array.from(new Set<VideoMode>(rawModes)) : base.modes

  const p = parsed.params && typeof parsed.params === 'object' ? parsed.params : {}
  const duration = Array.isArray(p.duration) && p.duration.length > 0
    ? p.duration.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
    : base.params.duration
  const resolution = Array.isArray(p.resolution) && p.resolution.length > 0
    ? p.resolution.map((s: any) => String(s).trim()).filter(Boolean)
    : base.params.resolution
  const aspectRatio = Array.isArray(p.aspectRatio) && p.aspectRatio.length > 0
    ? p.aspectRatio.map((s: any) => String(s).trim()).filter(Boolean)
    : base.params.aspectRatio
  const fps = Array.isArray(p.fps) && p.fps.length > 0
    ? p.fps.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
    : base.params.fps

  const il = parsed.inputLimits && typeof parsed.inputLimits === 'object' ? parsed.inputLimits : {}
  const maxImages = Number.isFinite(Number(il.maxImages)) ? Math.max(0, Number(il.maxImages)) : base.inputLimits.maxImages
  const maxVideos = Number.isFinite(Number(il.maxVideos)) ? Math.max(0, Number(il.maxVideos)) : base.inputLimits.maxVideos
  const maxAudios = Number.isFinite(Number(il.maxAudios)) ? Math.max(0, Number(il.maxAudios)) : base.inputLimits.maxAudios

  return {
    modes,
    params: {
      duration: duration.length > 0 ? duration : base.params.duration,
      resolution: resolution.length > 0 ? resolution : base.params.resolution,
      aspectRatio: aspectRatio.length > 0 ? aspectRatio : base.params.aspectRatio,
      ...(fps && fps.length > 0 ? { fps } : {}),
    },
    inputLimits: {
      maxImages,
      maxVideos,
      maxAudios,
      ...(typeof il.requireFirstFrame === 'boolean' ? { requireFirstFrame: il.requireFirstFrame } : {}),
      ...(typeof il.requireLastFrame === 'boolean' ? { requireLastFrame: il.requireLastFrame } : {}),
    },
  }
}

/**
 * 解析模型能力声明：优先使用数据库 ai_models.capabilities，未配置时按模型 key/name 匹配内置预设。
 */
export function resolveCapability(
  modelInput?: { key?: string; name?: string; capabilities?: any } | string | null,
): ModelCapability {
  if (!modelInput) return { ...DEFAULT_CAPABILITY }
  if (typeof modelInput === 'string') {
    const preset = PRESET_CAPABILITIES.find(item => item.match.test(modelInput))
    return preset ? structuredClone(preset.capability) : structuredClone(DEFAULT_CAPABILITY)
  }
  const ident = `${modelInput.key || ''} ${modelInput.name || ''}`.trim()
  const preset = ident ? PRESET_CAPABILITIES.find(item => item.match.test(ident)) : undefined
  const base = preset ? structuredClone(preset.capability) : structuredClone(DEFAULT_CAPABILITY)
  if (modelInput.capabilities) {
    return normalizeRawCapability(modelInput.capabilities, base)
  }
  return base
}

export interface ValidateModelParamsInput {
  mode?: VideoMode | string
  duration?: number
  resolution?: string
  aspectRatio?: string
  fps?: number
}

export interface ValidateModelParamsResult {
  valid: boolean
  errors: string[]
  normalized: {
    mode: VideoMode
    duration: number
    resolution: string
    aspectRatio: string
    fps?: number
  }
}

/**
 * 校验并归一化视频生成参数（mode / duration / resolution / aspectRatio / fps）。
 */
export function validateParams(
  cap: ModelCapability,
  input: ValidateModelParamsInput = {},
): ValidateModelParamsResult {
  const errors: string[] = []

  const requestedMode = input.mode ? parseGenMode(input.mode) : undefined
  if (input.mode && !requestedMode) {
    errors.push(`不支持的生成模式 "${String(input.mode)}"`)
  }
  const mode: VideoMode = requestedMode || cap.modes[0] || 'singleImage2video'
  if (!cap.modes.includes(mode)) {
    errors.push(`当前模型不支持生成模式 "${mode}"（支持的模式：${cap.modes.join(', ')}）`)
  }

  let duration = input.duration !== undefined ? Number(input.duration) : (cap.params.duration[0] || 5)
  if (input.duration !== undefined) {
    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push(`无效的视频时长 "${String(input.duration)}"`)
    } else if (cap.params.duration.length > 0 && !cap.params.duration.includes(duration)) {
      errors.push(`当前模型不支持时长 ${duration}s（可选时长：${cap.params.duration.join('s, ')}s）`)
    }
  }

  const resolution = input.resolution ? String(input.resolution).trim() : (cap.params.resolution[0] || '720p')
  if (input.resolution && cap.params.resolution.length > 0 && !cap.params.resolution.includes(resolution)) {
    errors.push(`当前模型不支持分辨率 "${resolution}"（可选分辨率：${cap.params.resolution.join(', ')}）`)
  }

  const aspectRatio = input.aspectRatio ? String(input.aspectRatio).trim() : (cap.params.aspectRatio[0] || '16:9')
  if (input.aspectRatio && cap.params.aspectRatio.length > 0 && !cap.params.aspectRatio.includes(aspectRatio)) {
    errors.push(`当前模型不支持宽高比 "${aspectRatio}"（可选宽高比：${cap.params.aspectRatio.join(', ')}）`)
  }

  const fps = input.fps !== undefined ? Number(input.fps) : cap.params.fps?.[0]
  if (input.fps !== undefined && cap.params.fps && cap.params.fps.length > 0 && !cap.params.fps.includes(Number(input.fps))) {
    errors.push(`当前模型不支持帧率 ${String(input.fps)}fps（可选帧率：${cap.params.fps.join(', ')}fps）`)
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized: {
      mode,
      duration,
      resolution,
      aspectRatio,
      ...(fps !== undefined ? { fps } : {}),
    },
  }
}

/**
 * 推导镜头的有效生成模式（优先取 shot.gen_mode，其次根据 frame_mode 与已有首尾帧推导）。
 */
export function inferShotVideoMode(
  shot: Record<string, any> | null | undefined,
  fallbackFrameMode?: 'single' | 'dual' | 'video_tail',
): VideoMode {
  if (!shot) return 'singleImage2video'
  const explicit = parseGenMode(shot.gen_mode)
  if (explicit) return explicit

  const fm = shot.frame_mode || fallbackFrameMode
  if (fm === 'dual' && shot.firstFrameUrl && shot.lastFrameUrl) {
    return 'frames2video'
  }
  if (shot.firstFrameUrl || shot.reference_frame_url) {
    return 'singleImage2video'
  }
  if (Array.isArray(shot.character_refs) && shot.character_refs.some((r: any) => r?.image_url)) {
    return 'image2video'
  }
  return 'singleImage2video'
}

/**
 * 按 modeType 组装镜头的多模态输入（首尾帧 / 角色参考图 / 参考视频 / 音频）并校验模型输入数量上限。
 */
export function collectInputs(
  shot: Record<string, any>,
  modeInput?: VideoMode | string,
  cap: ModelCapability = DEFAULT_CAPABILITY,
): CollectedShotInputs {
  const mode = parseGenMode(modeInput) || inferShotVideoMode(shot)
  if (!cap.modes.includes(mode)) {
    throw new Error(`模型不支持生成模式 "${mode}"（支持：${cap.modes.join(', ')}）`)
  }

  const imagePrompt = resolveShotImagePrompt(shot)
  const motionPrompt = resolveShotMotionPrompt(shot)
  const prompt = [motionPrompt, imagePrompt].filter(Boolean).join('；') || String(shot?.videoPrompt || shot?.content || '').trim()

  const firstFrameUrl = String(shot?.firstFrameUrl || shot?.reference_frame_url || '').trim() || undefined
  const lastFrameUrl = String(shot?.lastFrameUrl || '').trim() || undefined

  const charRefUrls: string[] = Array.isArray(shot?.character_refs)
    ? shot.character_refs
        .map((r: any) => String(r?.image_url || r?.url || '').trim())
        .filter(Boolean)
    : []
  const snapshotRefUrls: string[] = Array.isArray(shot?.character_references_snapshot)
    ? shot.character_references_snapshot
        .map((r: any) => String(r?.asset_url || r?.image_url || '').trim())
        .filter(Boolean)
    : []
  const rawRefImages = [...new Set([
    ...(shot?.reference_frame_url ? [String(shot.reference_frame_url).trim()] : []),
    ...charRefUrls,
    ...snapshotRefUrls,
  ].filter(Boolean))]

  const rawRefVideos = [...new Set([
    shot?.referenceVideoUrl,
    shot?.sourceVideoUrl,
    ...(Array.isArray(shot?.reference_video_urls) ? shot.reference_video_urls : []),
  ].map(v => String(v || '').trim()).filter(Boolean))]

  const rawAudios = [...new Set([
    shot?.ttsAudioUrl,
    shot?.audioUrl,
    ...(Array.isArray(shot?.audio_urls) ? shot.audio_urls : []),
  ].map(v => String(v || '').trim()).filter(Boolean))]

  const media: CollectedMediaItem[] = []
  let outFirstFrame: string | undefined
  let outLastFrame: string | undefined
  let referenceImageUrls: string[] = []
  let referenceVideoUrls: string[] = []
  let audioUrls: string[] = []

  switch (mode) {
    case 'text2video': {
      if (!prompt) {
        throw new Error('text2video 模式缺少运动/画面提示词（motion_prompt / image_prompt）')
      }
      break
    }

    case 'singleImage2video': {
      const primaryImg = firstFrameUrl || rawRefImages[0]
      if (!primaryImg) {
        throw new Error('singleImage2video 模式需要至少 1 张首帧图或参考帧（firstFrameUrl / reference_frame_url）')
      }
      outFirstFrame = primaryImg
      media.push({ type: 'first_frame', url: primaryImg, role: 'first_frame' })
      break
    }

    case 'frames2video': {
      if (!firstFrameUrl || !lastFrameUrl) {
        throw new Error('frames2video（首尾帧）模式必须同时提供首帧图（firstFrameUrl）与尾帧图（lastFrameUrl）')
      }
      if (cap.inputLimits.maxImages < 2) {
        throw new Error(`当前模型最多允许 ${cap.inputLimits.maxImages} 张图片输入，无法执行 frames2video 首尾双帧生成`)
      }
      outFirstFrame = firstFrameUrl
      outLastFrame = lastFrameUrl
      media.push(
        { type: 'first_frame', url: firstFrameUrl, role: 'first_frame' },
        { type: 'last_frame', url: lastFrameUrl, role: 'last_frame' },
      )
      break
    }

    case 'image2video': {
      const allImgs = [...new Set([
        ...(firstFrameUrl ? [firstFrameUrl] : []),
        ...rawRefImages,
      ])]
      if (allImgs.length === 0) {
        throw new Error('image2video（多图参考）模式需要至少 1 张角色参考图或关键帧图')
      }
      if (cap.inputLimits.maxImages > 0 && allImgs.length > cap.inputLimits.maxImages) {
        throw new Error(`image2video 模式传入了 ${allImgs.length} 张参考图，超出模型上限 ${cap.inputLimits.maxImages} 张`)
      }
      referenceImageUrls = allImgs
      outFirstFrame = firstFrameUrl || allImgs[0]
      for (const url of allImgs) {
        media.push({ type: 'image', url, role: 'reference_image' })
      }
      break
    }

    case 'video2video':
    case 'videoEdit2video': {
      const refVideo = rawRefVideos[0] || String(shot?.videoUrl || '').trim()
      if (!refVideo) {
        throw new Error(`${mode} 模式需要提供参考视频（referenceVideoUrl / videoUrl）`)
      }
      if (cap.inputLimits.maxVideos < 1) {
        throw new Error(`当前模型不支持视频参考输入（maxVideos=${cap.inputLimits.maxVideos}）`)
      }
      referenceVideoUrls = [refVideo]
      media.push({ type: 'video', url: refVideo, role: mode === 'videoEdit2video' ? 'edit_source' : 'reference_video' })
      if (firstFrameUrl && cap.inputLimits.maxImages >= 1) {
        outFirstFrame = firstFrameUrl
        referenceImageUrls = [firstFrameUrl]
        media.push({ type: 'image', url: firstFrameUrl, role: 'reference_image' })
      }
      break
    }

    case 'audio2video': {
      if (rawAudios.length === 0) {
        throw new Error('audio2video 模式需要提供驱动音频（ttsAudioUrl / audioUrl）')
      }
      if (cap.inputLimits.maxAudios < 1) {
        throw new Error(`当前模型不支持音频驱动输入（maxAudios=${cap.inputLimits.maxAudios}）`)
      }
      audioUrls = rawAudios.slice(0, cap.inputLimits.maxAudios)
      for (const url of audioUrls) {
        media.push({ type: 'audio', url, role: 'driving_audio' })
      }
      const primaryImg = firstFrameUrl || rawRefImages[0]
      if (primaryImg) {
        outFirstFrame = primaryImg
        media.push({ type: 'first_frame', url: primaryImg, role: 'first_frame' })
      }
      break
    }

    case 'mixed2video': {
      const allImgs = [...new Set([
        ...(firstFrameUrl ? [firstFrameUrl] : []),
        ...(lastFrameUrl ? [lastFrameUrl] : []),
        ...rawRefImages,
      ])]
      if (cap.inputLimits.maxImages > 0 && allImgs.length > cap.inputLimits.maxImages) {
        throw new Error(`mixed2video 模式传入了 ${allImgs.length} 张图片，超出模型上限 ${cap.inputLimits.maxImages} 张`)
      }
      if (cap.inputLimits.maxVideos > 0 && rawRefVideos.length > cap.inputLimits.maxVideos) {
        throw new Error(`mixed2video 模式传入了 ${rawRefVideos.length} 段视频，超出模型上限 ${cap.inputLimits.maxVideos} 段`)
      }
      if (cap.inputLimits.maxAudios > 0 && rawAudios.length > cap.inputLimits.maxAudios) {
        throw new Error(`mixed2video 模式传入了 ${rawAudios.length} 段音频，超出模型上限 ${cap.inputLimits.maxAudios} 段`)
      }
      if (allImgs.length === 0 && rawRefVideos.length === 0 && rawAudios.length === 0 && !prompt) {
        throw new Error('mixed2video 模式需要至少提供一种多模态输入（图片/视频/音频/提示词）')
      }
      outFirstFrame = firstFrameUrl || allImgs[0]
      outLastFrame = lastFrameUrl
      referenceImageUrls = allImgs
      referenceVideoUrls = rawRefVideos.slice(0, Math.max(0, cap.inputLimits.maxVideos))
      audioUrls = rawAudios.slice(0, Math.max(0, cap.inputLimits.maxAudios))

      for (const url of referenceImageUrls) {
        media.push({ type: 'image', url, role: url === outFirstFrame ? 'first_frame' : 'reference_image' })
      }
      for (const url of referenceVideoUrls) {
        media.push({ type: 'video', url, role: 'reference_video' })
      }
      for (const url of audioUrls) {
        media.push({ type: 'audio', url, role: 'reference_audio' })
      }
      break
    }
  }

  return {
    mode,
    prompt,
    imagePrompt,
    motionPrompt,
    ...(outFirstFrame ? { firstFrameUrl: outFirstFrame } : {}),
    ...(outLastFrame ? { lastFrameUrl: outLastFrame } : {}),
    referenceImageUrls,
    referenceVideoUrls,
    audioUrls,
    media,
  }
}
