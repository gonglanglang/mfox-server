import "dotenv/config"

const BASE_URL = process.env.FIREBASE_API_URL || ''
const API_KEY = process.env.FIREBASE_API_KEY || ''

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  if (!BASE_URL || !API_KEY) {
    console.error('缺少 FIREBASE_API_URL 或 FIREBASE_API_KEY 环境变量')
    return
  }

  // 1. 提交任务：纯文本 + generate_audio=true（测试是否生成环境音/音效）
  const submitUrl = `${BASE_URL.replace(/\/+$/, '')}/contents/generations/tasks`
  const body = {
    model: 'doubao-seedance-1-5-pro-251215',
    content: [
      { type: 'text', text: 'A woman in high heels walking on a marble floor in a quiet corridor, echoing footsteps, cinematic' }
    ],
    ratio: '16:9',
    duration: 5,
    resolution: '480p',
    generate_audio: true, // 开启音频
    watermark: false,
    seed: -1,
    output_format: 'mp4',
  }

  console.log('提交请求:', JSON.stringify(body, null, 2))
  const res = await fetch(submitUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  })

  console.log('提交状态码:', res.status)
  const data: any = await res.json()
  console.log('提交响应:', JSON.stringify(data, null, 2))

  const taskId = data?.id || ''
  if (!taskId) {
    console.error('无 taskId，提交失败')
    return
  }

  // 2. 轮询查询
  const queryUrl = `${BASE_URL.replace(/\/+$/, '')}/contents/generations/tasks/${taskId}`
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const qres = await fetch(queryUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } })
    const qdata: any = await qres.json()
    const status = qdata?.status || ''
    console.log(`状态(${i + 1}): ${status}`)

    if (status === 'succeeded') {
      console.log('\n=== 完成响应（完整 JSON）===')
      console.log(JSON.stringify(qdata, null, 2))
      break
    }
    if (status === 'failed') {
      console.log('\n=== 失败响应 ===')
      console.log(JSON.stringify(qdata, null, 2))
      break
    }
  }
}

main().catch(e => console.error('脚本失败:', e))
