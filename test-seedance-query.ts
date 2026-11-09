import "dotenv/config"

const BASE_URL = process.env.FIREBASE_API_URL || ''
const API_KEY = process.env.FIREBASE_API_KEY || ''
const taskId = 'cgt-20260813121508-g26pz'

async function main() {
  if (!BASE_URL || !API_KEY) {
    console.error('缺少 FIREBASE_API_URL 或 FIREBASE_API_KEY 环境变量')
    return
  }

  const queryUrl = `${BASE_URL.replace(/\/+$/, '')}/contents/generations/tasks/${taskId}`
  console.log('查询 URL:', queryUrl)
  console.log('taskId:', taskId)
  console.log('')

  const res = await fetch(queryUrl, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  })

  console.log('HTTP 状态码:', res.status)
  const text = await res.text()
  console.log('原始响应:', text)

  try {
    const data = JSON.parse(text)
    console.log('\n--- 格式化 JSON ---')
    console.log(JSON.stringify(data, null, 2))
  } catch {
    // 非 JSON 响应，忽略
  }
}

main().catch(e => console.error('查询失败:', e))
