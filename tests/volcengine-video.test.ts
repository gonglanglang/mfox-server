import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildVolcengineContent,
  normalizeSeedancePromptRefs,
  volcengineVideoAdapter,
} from '../src/videoTools/adapters/volcengine'
import { resolveVideoAdapter } from '../src/videoTools/adapters'
import { resolveImageAdapter } from '../src/imageTools/adapters'

test('normalizeSeedancePromptRefs 将 图N / 音频N / 视频N 转换为 @图像N / @音频N / @视频N', () => {
  const raw = '以图1为起始画面、图2为下一帧参考，使用音频1的音色说话，参考视频1的镜头衔接。'
  const out = normalizeSeedancePromptRefs(raw)
  assert.equal(out, '以@图像1为起始画面、@图像2为下一帧参考，使用@音频1的音色说话，参考@视频1的镜头衔接。')
})

test('Seedance 2.0 全模态模式组装 content 数组（text + reference_image + reference_video + reference_audio）', () => {
  const content = buildVolcengineContent(
    {
      model: 'doubao-seedance-2-0-mini-260615',
      prompt: '以图1为起始画面，使用音频1配音，衔接视频1',
      media: [
        { type: 'reference_image', url: 'https://example.com/frame1.jpg' },
        { type: 'reference_video', url: 'https://example.com/prev.mp4' },
        { type: 'reference_audio', url: 'https://example.com/line1.mp3' },
      ],
    },
    { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'sk-test' },
  )

  assert.deepEqual(content, [
    { type: 'text', text: '以@图像1为起始画面，使用@音频1配音，衔接@视频1' },
    { type: 'image_url', image_url: { url: 'https://example.com/frame1.jpg' }, role: 'reference_image' },
    { type: 'video_url', video_url: { url: 'https://example.com/prev.mp4' }, role: 'reference_video' },
    { type: 'audio_url', audio_url: { url: 'https://example.com/line1.mp3' }, role: 'reference_audio' },
  ])
})

test('Seedance 1.0 / 1.5 模型自动切换为 first_frame / last_frame 模式', () => {
  const content = buildVolcengineContent(
    {
      model: 'doubao-seedance-1-5-pro-251215',
      prompt: '镜头缓慢推近',
      media: [
        { type: 'reference_image', url: 'https://example.com/first.jpg' },
        { type: 'reference_image', url: 'https://example.com/last.jpg' },
        { type: 'reference_audio', url: 'https://example.com/line1.mp3' },
      ],
    },
    { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'sk-test' },
  )

  assert.deepEqual(content, [
    { type: 'text', text: '镜头缓慢推近' },
    { type: 'image_url', image_url: { url: 'https://example.com/first.jpg' }, role: 'first_frame' },
    { type: 'image_url', image_url: { url: 'https://example.com/last.jpg' }, role: 'last_frame' },
  ])
})

test('resolveVideoAdapter 与 resolveImageAdapter 支持同一火山引擎供应商跨模态共用', () => {
  // 火山引擎供应商 protocol='openai-images' 时，视频模型依然能通过 endpoint/provider/baseUrl 命中 volcengineVideoAdapter
  const vAdapter1 = resolveVideoAdapter(
    'openai-images',
    'AI Hub',
    'https://ark.cn-beijing.volces.com/api/v3',
    '/contents/generations/tasks',
  )
  assert.equal(vAdapter1, volcengineVideoAdapter)

  const vAdapter2 = resolveVideoAdapter(
    'volcengine-ark',
    'volcengine',
    'https://ark.cn-beijing.volces.com/api/v3',
    '',
  )
  assert.equal(vAdapter2, volcengineVideoAdapter)

  // 当供应商 protocol='volcengine-ark' 时，其下属图片模型也能正常命中 openai-images 适配器
  const iAdapter = resolveImageAdapter('volcengine-ark', 'volcengine')
  assert.ok(iAdapter)
  assert.equal(iAdapter?.protocol, 'openai-images')
})
