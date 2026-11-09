import "dotenv/config"

const BASE_URL = process.env.FIREBASE_API_URL || ''
const API_KEY = process.env.FIREBASE_API_KEY || ''
const taskId = 'cgt-20260813132649-n9kt5'

async function main() {
  // 1. 查询任务拿 video_url
  const queryUrl = `${BASE_URL.replace(/\/+$/, '')}/contents/generations/tasks/${taskId}`
  const qres = await fetch(queryUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } })
  const qdata: any = await qres.json()
  const videoUrl = qdata?.content?.video_url || ''
  console.log('video_url:', videoUrl)

  if (!videoUrl) { console.error('无 video_url'); return }

  // 2. 下载视频
  const vres = await fetch(videoUrl)
  const buf = Buffer.from(await vres.arrayBuffer())
  console.log('视频大小:', (buf.length / 1024).toFixed(1), 'KB')

  // 3. 检查 MP4 是否含音频轨道（搜索 AAC 编码标识 'mp4a' 和 audio handler 'soun'）
  const mp4aIdx = buf.indexOf(Buffer.from('mp4a'))
  const sounIdx = buf.indexOf(Buffer.from('soun'))
  const aacIdx = buf.indexOf(Buffer.from('aac'))

  console.log('\n=== 音轨检测 ===')
  console.log("'mp4a' (AAC 音频编码):", mp4aIdx >= 0 ? `✅ 找到（偏移 ${mp4aIdx}）` : '❌ 未找到')
  console.log("'soun' (音频 handler):", sounIdx >= 0 ? `✅ 找到（偏移 ${sounIdx}）` : '❌ 未找到')
  console.log("'aac' :", aacIdx >= 0 ? `✅ 找到（偏移 ${aacIdx}）` : '❌ 未找到')

  const hasAudio = mp4aIdx >= 0 || sounIdx >= 0
  console.log('\n结论:', hasAudio ? '✅ 视频带音轨（generate_audio 生效）' : '❌ 视频无声（generate_audio 未生效或未合成）')
}

main().catch(e => console.error('脚本失败:', e))
