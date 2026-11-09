import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || 'test'
process.env.OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || 'test'
process.env.OSS_REGION = process.env.OSS_REGION || 'oss-cn-hangzhou'
process.env.OSS_BUCKET = process.env.OSS_BUCKET || 'test'

const { normalizeTailFrameWording, normalizeEmotion, dialogueAudioKey } = await import('../src/mastra/workflows/frame-video.workflow')
const { sanitizeShotNegativePrompt, sanitizeVideoPromptAvoidClause } = await import('../src/mastra/workflows/NovelScriptFlows/index')
const { resolveTtsSpeed } = await import('../src/tts/index')

test('尾帧措辞统一改写为「下一帧参考」，避免视频结尾硬切出参考图', () => {
  assert.equal(
    normalizeTailFrameWording('以图1为起始画面、图2为收尾画面，采用中景侧面机位推镜头。'),
    '以图1为起始画面、图2为下一帧参考，采用中景侧面机位推镜头。')
  assert.equal(normalizeTailFrameWording('图2 作为结尾画面，参考使用。'), '图2 为下一帧参考，参考使用。')
  assert.equal(normalizeTailFrameWording('画面最后停在最后一帧'), '画面最后停在下一帧')
})

test('正常措辞与空输入不受影响', () => {
  const normal = '郭晴站在画面中央偏左，图2为下一帧参考，动作连续演进到本镜结束。'
  assert.equal(normalizeTailFrameWording(normal), normal)
  assert.equal(normalizeTailFrameWording(''), '')
})

test('MiniMax 情绪值过滤：whisper 与非白名单值不传', () => {
  assert.equal(normalizeEmotion('sad'), 'sad')
  assert.equal(normalizeEmotion(' CALM '), 'calm')
  // whisper 只在 2.6 系列生效，当前模型（speech-2.8-hd）不支持 → 映射为 calm
  assert.equal(normalizeEmotion('whisper'), 'calm')
  // 分镜枚举之外的脏值同样不传
  assert.equal(normalizeEmotion('温情'), '')
  assert.equal(normalizeEmotion(''), '')
  assert.equal(normalizeEmotion(undefined), '')
})

test('配音指纹：文本/情绪/归属/音色任一变化都要重新配音', () => {
  const base = { speaker: '郭晴', roleId: 32, text: '我说了算。', emotion: 'calm', voiceId: 'ttv-voice-A' }
  const key = dialogueAudioKey(base)
  // 完全一致 → 复用旧音频（不重复调用 TTS）
  assert.equal(dialogueAudioKey({ ...base }), key)
  // 改台词
  assert.notEqual(dialogueAudioKey({ ...base, text: '我说了算！' }), key)
  // 改情绪
  assert.notEqual(dialogueAudioKey({ ...base, emotion: 'angry' }), key)
  // 归属被纠正（郭晴的台词原本挂在何杰熊名下）
  assert.notEqual(dialogueAudioKey({ ...base, roleId: 34 }), key)
  assert.notEqual(dialogueAudioKey({ ...base, speaker: '何杰熊' }), key)
  // 换音色
  assert.notEqual(dialogueAudioKey({ ...base, voiceId: 'ttv-voice-B' }), key)
})

test('sanitizeShotNegativePrompt 與 sanitizeVideoPromptAvoidClause 剔除瞬时姿态冲突项并去重', () => {
  const headNeg = '人物过多或缺少人物；改变发型发色、服饰补丁、年龄或体型；画面出现文字、水印、拼图边框。'
  const tailNeg = '人物仍站立未跌坐；水花缺失；执事身影缺失或过度清晰成多余角色；改变发型发色、服饰补丁、年龄或体型；画面出现文字、水印、拼图边框。'
  const cleaned = sanitizeShotNegativePrompt(tailNeg, headNeg)
  assert.ok(!cleaned.includes('仍站立'))
  assert.ok(!cleaned.includes('水花缺失'))
  assert.ok(!cleaned.includes('执事身影缺失'))
  assert.equal(cleaned, '改变发型发色、服饰补丁、年龄或体型；画面出现文字、水印、拼图边框；人物过多或缺少人物')

  const videoPrompt = '沈无咎立在门槛外全程保持站立。避免出现：人物仍站立未跌坐；水花缺失；改变发型发色、服饰补丁；出现文字、水印。'
  assert.equal(
    sanitizeVideoPromptAvoidClause(videoPrompt),
    '沈无咎立在门槛外全程保持站立。避免出现：改变发型发色、服饰补丁；出现文字、水印。',
  )
})

test('resolveTtsSpeed 按语气词微调语速', () => {
  assert.equal(resolveTtsSpeed('喘气'), 1.06)
  assert.equal(resolveTtsSpeed('嘶吼'), 1.06)
  assert.equal(resolveTtsSpeed('低声'), 0.94)
  assert.equal(resolveTtsSpeed('沙哑'), 0.94)
  assert.equal(resolveTtsSpeed('平静'), undefined)
  assert.equal(resolveTtsSpeed(''), undefined)
  assert.equal(resolveTtsSpeed('喘气', 1.15), 1.15)
})
