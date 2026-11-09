import { executeImageNode, type ImageNodeInput, type ImageNodeOutput } from './nodes/image-node'
import { executeVideoNode, type VideoNodeInput, type VideoNodeOutput } from './nodes/video-node'
import { executeAudioNode, type AudioNodeInput, type AudioNodeOutput } from './nodes/audio-node'
import { executeComposeNode, type ComposeNodeInput, type ComposeNodeOutput } from './nodes/compose-node'
import { upscaleVideo, type UpscaleVideoOptions, type UpscaleVideoResult } from '../videoTools/upscale'

export type PipelineNodeType = 'image' | 'video' | 'audio' | 'compose' | 'upscale'

export interface PipelineNodeHandler<TInput = any, TOutput = any> {
  type: PipelineNodeType
  description: string
  execute: (input: TInput) => Promise<TOutput>
}

const nodeRegistry = new Map<PipelineNodeType, PipelineNodeHandler>([
  [
    'image',
    {
      type: 'image',
      description: '分镜关键帧生图节点（支持首帧/尾帧/参考帧与行级角色卡）',
      execute: (input: ImageNodeInput): Promise<ImageNodeOutput> => executeImageNode(input),
    },
  ],
  [
    'video',
    {
      type: 'video',
      description: '分镜视频生成节点（按 modeType 自动收集输入并校验模型 Schema）',
      execute: (input: VideoNodeInput): Promise<VideoNodeOutput> => executeVideoNode(input),
    },
  ],
  [
    'audio',
    {
      type: 'audio',
      description: '分镜 TTS 音频合成节点',
      execute: (input: AudioNodeInput): Promise<AudioNodeOutput> => executeAudioNode(input),
    },
  ],
  [
    'compose',
    {
      type: 'compose',
      description: '时间线视频合成节点（支持逐段入出点裁剪、分贝与双轨音量）',
      execute: (input: ComposeNodeInput): Promise<ComposeNodeOutput> => executeComposeNode(input),
    },
  ],
  [
    'upscale',
    {
      type: 'upscale',
      description: '视频超分节点（Lanczos + Unsharp 1080P/2K/4K）',
      execute: (input: UpscaleVideoOptions): Promise<UpscaleVideoResult> => upscaleVideo(input),
    },
  ],
])

export function getPipelineNodeHandler(type: PipelineNodeType): PipelineNodeHandler {
  const handler = nodeRegistry.get(type)
  if (!handler) {
    throw new Error(`未注册的流水线节点类型: ${String(type)}`)
  }
  return handler
}

export function listPipelineNodeTypes(): { type: PipelineNodeType; description: string }[] {
  return Array.from(nodeRegistry.values()).map(({ type, description }) => ({ type, description }))
}
