import WxPay from 'wechatpay-node-v3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { db, schema } from '../mysqlDb'
import { eq, and, sql, desc, lt } from 'drizzle-orm'
import { success, error } from '../tools/response'
import { authMiddleware } from '../middleware/auth'
import { writePointsLedger } from '../tools/index'

const app = express.Router()

// ============================================
// 支付配置（.env）
// ============================================
// 支付 appid：必须是【与商户号同主体】的已认证服务号/小程序 appid；
// 与登录用的 WX_APPID（个人公众号，仅扫码登录）分开，避免混用
const payAppid = process.env.WX_PAY_APPID || process.env.WX_APPID || '' // 支付公众号/小程序 appid
const mchid = process.env.WX_MCHID || '' // 商户号
const serialNo = process.env.API_Certificate_Serial_Number || '' // 商户 API 证书序列号
const apiV3Key = process.env.WX_API_V3_KEY || '' // APIv3 密钥（回调验签/解密必需）
const notifyUrl = process.env.WX_NOTIFY_URL || 'https://chatfox.cc/pay/notify' // 支付结果回调地址

// 证书读取：相对于当前源码文件（src/routes/pay.ts → src/config/pay/），不依赖启动目录
const certDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/pay')

if (!payAppid) {
  console.warn('⚠️  未配置 WX_PAY_APPID / WX_APPID，无法发起微信支付')
}
if (!apiV3Key) {
  console.warn('⚠️  未配置 WX_API_V3_KEY（APIv3密钥），支付回调验签/解密将失败，请在 .env 中填写商户平台 APIv3 密钥')
}

const wxPay = new WxPay({
  appid: payAppid,
  mchid,
  serial_no: serialNo,
  publicKey: fs.readFileSync(path.join(certDir, 'apiclient_cert.pem')), // 商户 API 证书公钥
  privateKey: fs.readFileSync(path.join(certDir, 'apiclient_key.pem')), // 商户 API 证书私钥
  key: apiV3Key, // APIv3 密钥
})

// ============================================
// 充值套餐（后端权威定价，防止前端篡改金额）
// amount 单位：分；对照前端 PointsBadge 的 6 档
// 1:¥9.9  2:¥29.9  3:¥68  4:¥128  5:¥258  6:¥518
// ============================================
const PLANS = [
  { id: 1, amount: 990, points: 1000 },
  { id: 2, amount: 2990, points: 3200 },
  { id: 3, amount: 6800, points: 7500 },
  { id: 4, amount: 12800, points: 15000 },
  { id: 5, amount: 25800, points: 32000 },
  { id: 6, amount: 51800, points: 68000 },
] as const

const now = () => new Date()
const genOrderNo = () =>
  `R${Date.now()}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`

// ============================================
// 订单有效期：1 小时
// 下单时通过 time_expire 告知微信（上限 2 小时），到期后微信侧不可再支付；
// 本地查询时也会把超时的 pending 单自动置为 closed
// ============================================
const ORDER_EXPIRE_MINUTES = 60
const ORDER_EXPIRE_MS = ORDER_EXPIRE_MINUTES * 60 * 1000

/** 订单支付截止时间 = 下单时间 + 有效期 */
const orderExpireAt = (createdAt: Date) => new Date(createdAt.getTime() + ORDER_EXPIRE_MS)

/** 微信 v3 时间格式：RFC3339 带时区，如 2024-01-01T10:00:00+08:00（按东八区输出） */
const toWxTime = (d: Date) =>
  new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00')

/** 把超过有效期的 pending 订单置为 closed（可不限定用户全局清理） */
async function closeExpiredOrders(userId?: number): Promise<void> {
  const deadline = new Date(Date.now() - ORDER_EXPIRE_MS)
  const conds = [
    eq(schema.recharge_orders.status, 'pending'),
    lt(schema.recharge_orders.createdAt, deadline),
  ]
  if (userId !== undefined) {
    conds.push(eq(schema.recharge_orders.userId, userId))
  }
  const [upd] = await db
    .update(schema.recharge_orders)
    .set({ status: 'closed', updatedAt: now() })
    .where(and(...conds))
  if (upd.affectedRows > 0) {
    console.log(`⏰ 自动关闭 ${upd.affectedRows} 个过期待支付订单`)
  }
}

// ============================================
// 创建 Native 扫码下单
// POST /pay/orders  body: { planId }
// 返回 { orderNo, codeUrl, plan }：codeUrl 为微信收款二维码内容
// ============================================
app.post('/orders', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id as number
    const planId = Number(req.body?.planId)
    const plan = PLANS.find((p) => p.id === planId)
    if (!plan) return error(res, '无效的充值套餐', 400)

    // 同用户旧的待支付订单直接关闭，避免堆积脏单
    const ts = now()
    await db
      .update(schema.recharge_orders)
      .set({ status: 'closed', updatedAt: ts })
      .where(
        and(
          eq(schema.recharge_orders.userId, userId),
          eq(schema.recharge_orders.status, 'pending'),
        ),
      )

    const orderNo = genOrderNo()
    await db.insert(schema.recharge_orders).values({
      orderNo,
      userId,
      planId: plan.id,
      amount: plan.amount,
      points: plan.points,
      status: 'pending',
      transactionId: null,
      createdAt: ts,
      updatedAt: ts,
    })

    const result = await wxPay.transactions_native({
      description: `积分充值：${plan.points} 积分`,
      out_trade_no: orderNo,
      notify_url: notifyUrl,
      time_expire: toWxTime(new Date(ts.getTime() + ORDER_EXPIRE_MS)), // 支付截止时间（1 小时后失效）
      amount: {
        total: plan.amount, // 单位：分
        currency: 'CNY',
      },
      scene_info: {
        payer_client_ip: (req.ip as string) || '127.0.0.1', // 用户 IP
      },
    })

    console.log('微信下单结果:', result)

    // 库返回 { status, data }；下单失败不抛异常，status 非 200
    if (result.status !== 200) {
      await db
        .update(schema.recharge_orders)
        .set({ status: 'closed', updatedAt: now() })
        .where(eq(schema.recharge_orders.orderNo, orderNo))

      let msg = '微信下单失败'
      try {
        const parsed = JSON.parse(String(result.error ?? '{}'))
        msg = parsed?.message || msg
      } catch { /* 非 JSON 错误文本 */ }
      return error(res, msg, 502)
    }

    const codeUrl = (result.data as { code_url?: string })?.code_url
    if (!codeUrl) return error(res, '微信下单失败：未返回付款码', 502)

    return success(res, {
      orderNo,
      codeUrl,
      amount: plan.amount,
      points: plan.points,
      expireAt: orderExpireAt(ts).toISOString(), // 支付截止时间
    })
  } catch (err) {
    console.error('❌ 创建充值订单失败:', err)
    return error(res, '创建充值订单失败', 500)
  }
})

// ============================================
// 微信支付结果回调（微信服务器 → 商户服务器）
// POST /pay/notify  （body 为 raw JSON，见 index.ts 前置处理）
// 验签 → 解密 → 幂等入账（订单置 paid + 用户积分到账）
// ============================================
app.post('/notify', async (req, res) => {
  const confirm = (code: 'SUCCESS' | 'FAIL', message = '') =>
    res.json({ code, message })

  try {
    const timestamp = req.headers['wechatpay-timestamp'] as string
    const nonce = req.headers['wechatpay-nonce'] as string
    const signature = req.headers['wechatpay-signature'] as string
    const serial = req.headers['wechatpay-serial'] as string
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body)

    if (!timestamp || !nonce || !signature || !serial) {
      return confirm('FAIL', '缺少微信签名头')
    }

    // 1. 验签（自动拉取/使用微信支付平台证书公钥）
    const pass = await wxPay.verifySign({
      timestamp,
      nonce,
      body: rawBody,
      serial,
      signature,
      apiSecret: apiV3Key,
    })
    if (!pass) return confirm('FAIL', '验签失败')

    // 2. 解密业务数据
    const body = JSON.parse(rawBody)
    const { ciphertext, associated_data, nonce: encNonce } = body.resource ?? {}
    if (!ciphertext || !associated_data || !encNonce) {
      return confirm('FAIL', '通知数据不完整')
    }
    const data = wxPay.decipher_gcm<{
      out_trade_no: string
      transaction_id: string
      trade_state: string
      amount?: { total?: number; currency?: string }
      success_time?: string
    }>(ciphertext, associated_data, encNonce, apiV3Key)

    // 仅处理支付成功事件；其余事件直接确认
    if (body.event_type !== 'TRANSACTION.SUCCESS' || data.trade_state !== 'SUCCESS') {
      return confirm('SUCCESS')
    }

    const { out_trade_no, transaction_id } = data

    // 3. 查订单：不存在 → FAIL（微信会重试）
    const [order] = await db
      .select()
      .from(schema.recharge_orders)
      .where(eq(schema.recharge_orders.orderNo, out_trade_no))
    if (!order) return confirm('FAIL', '订单不存在')

    // 已到账：重复通知直接确认（幂等）
    if (order.status === 'paid') return confirm('SUCCESS')

    // 4. 金额校验：回调金额必须等于订单金额
    if (Number(data.amount?.total) !== order.amount) {
      console.error('❌ 支付金额与订单不符:', out_trade_no, data.amount?.total, order.amount)
      return confirm('FAIL', '金额校验失败')
    }

    // 5. 原子入账：仅当订单仍为 pending 时置为 paid（防并发重复加积分）
    const paidAt = data.success_time ? new Date(data.success_time) : now()
    const [upd] = await db
      .update(schema.recharge_orders)
      .set({ status: 'paid', transactionId: transaction_id, paidAt, updatedAt: now() })
      .where(
        and(
          eq(schema.recharge_orders.orderNo, out_trade_no),
          eq(schema.recharge_orders.status, 'pending'),
        ),
      )

    if (upd.affectedRows === 1) {
      // 积分到账（SQL 原子自增，避免并发读改写）
      await db
        .update(schema.users)
        .set({ points: sql`points + ${order.points}` })
        .where(eq(schema.users.id, order.userId))
      // 写积分流水（biz_id=订单号，天然幂等；balance_after 取到账后余额）
      const [u] = await db.select({ points: schema.users.points }).from(schema.users).where(eq(schema.users.id, order.userId)).limit(1)
      await writePointsLedger(order.userId, order.points, u?.points ?? 0, 'recharge', out_trade_no)
      console.log(`✅ 充值到账 order=${out_trade_no} userId=${order.userId} points=${order.points}`)
    }

    return confirm('SUCCESS')
  } catch (err) {
    console.error('❌ 支付回调处理失败:', err)
    return confirm('FAIL', '处理失败')
  }
})

// ============================================
// 取消订单（仅待支付单）：通知微信关闭 + 本地置 closed
// POST /pay/orders/:orderNo/cancel
// ============================================
app.post('/orders/:orderNo/cancel', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id as number
    const orderNo = String(req.params.orderNo ?? '')
    const [order] = await db
      .select()
      .from(schema.recharge_orders)
      .where(
        and(
          eq(schema.recharge_orders.orderNo, orderNo),
          eq(schema.recharge_orders.userId, userId),
        ),
      )
    if (!order) return error(res, '订单不存在', 404)
    if (order.status !== 'pending') return error(res, '只有待支付订单可以取消', 400)

    // 通知微信关闭（防止旧收款码仍能付款；失败不影响本地关单）
    try {
      await wxPay.close(orderNo)
    } catch (e) {
      console.warn('⚠️ 微信关单失败（忽略）:', e)
    }

    const [upd] = await db
      .update(schema.recharge_orders)
      .set({ status: 'closed', updatedAt: now() })
      .where(
        and(
          eq(schema.recharge_orders.orderNo, orderNo),
          eq(schema.recharge_orders.status, 'pending'),
        ),
      )

    return success(res, { canceled: upd.affectedRows === 1 })
  } catch (err) {
    console.error('❌ 取消订单失败:', err)
    return error(res, '取消订单失败', 500)
  }
})

// ============================================
// 继续支付（订单列表“继续支付”）：原待支付单未超时 → 微信关旧单+本地关旧单，
// 再按同套餐新建一单并发起 Native 下单，返回新单收款码
// POST /pay/orders/:orderNo/pay
// ============================================
app.post('/orders/:orderNo/pay', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id as number
    const orderNo = String(req.params.orderNo ?? '')
    const [order] = await db
      .select()
      .from(schema.recharge_orders)
      .where(
        and(
          eq(schema.recharge_orders.orderNo, orderNo),
          eq(schema.recharge_orders.userId, userId),
        ),
      )
    if (!order) return error(res, '订单不存在', 404)
    if (order.status !== 'pending') return error(res, '该订单当前状态不可继续支付', 400)
    if (orderExpireAt(order.createdAt).getTime() <= Date.now()) {
      // 已超时：本地关掉，前端引导重新下单
      await db
        .update(schema.recharge_orders)
        .set({ status: 'closed', updatedAt: now() })
        .where(
          and(
            eq(schema.recharge_orders.orderNo, orderNo),
            eq(schema.recharge_orders.status, 'pending'),
          ),
        )
      return error(res, '订单已超时关闭，请重新下单', 400)
    }

    const plan = PLANS.find((p) => p.id === order.planId)
    if (!plan) return error(res, '订单套餐不存在', 400)

    // 1) 关闭微信侧旧单，避免旧收款码仍可付款
    try {
      await wxPay.close(orderNo)
    } catch (e) {
      console.warn('⚠️ 微信关单失败（忽略）:', e)
    }

    // 2) 本地关闭旧单
    await db
      .update(schema.recharge_orders)
      .set({ status: 'closed', updatedAt: now() })
      .where(
        and(
          eq(schema.recharge_orders.orderNo, orderNo),
          eq(schema.recharge_orders.status, 'pending'),
        ),
      )

    // 3) 按同套餐新建订单并发起 Native 下单
    const ts = now()
    const newOrderNo = genOrderNo()
    await db.insert(schema.recharge_orders).values({
      orderNo: newOrderNo,
      userId,
      planId: plan.id,
      amount: plan.amount,
      points: plan.points,
      status: 'pending',
      transactionId: null,
      createdAt: ts,
      updatedAt: ts,
    })

    const result = await wxPay.transactions_native({
      description: `积分充值：${plan.points} 积分`,
      out_trade_no: newOrderNo,
      notify_url: notifyUrl,
      time_expire: toWxTime(new Date(ts.getTime() + ORDER_EXPIRE_MS)),
      amount: {
        total: plan.amount,
        currency: 'CNY',
      },
      scene_info: {
        payer_client_ip: (req.ip as string) || '127.0.0.1',
      },
    })

    if (result.status !== 200) {
      await db
        .update(schema.recharge_orders)
        .set({ status: 'closed', updatedAt: now() })
        .where(eq(schema.recharge_orders.orderNo, newOrderNo))
      let msg = '微信下单失败'
      try {
        const parsed = JSON.parse(String(result.error ?? '{}'))
        msg = parsed?.message || msg
      } catch { /* 非 JSON 错误文本 */ }
      return error(res, msg, 502)
    }

    const codeUrl = (result.data as { code_url?: string })?.code_url
    if (!codeUrl) return error(res, '微信下单失败：未返回付款码', 502)

    return success(res, {
      orderNo: newOrderNo,
      codeUrl,
      amount: plan.amount,
      points: plan.points,
      expireAt: orderExpireAt(ts).toISOString(),
    })
  } catch (err) {
    console.error('❌ 继续支付失败:', err)
    return error(res, '继续支付失败', 500)
  }
})

// ============================================
// 查询我的充值订单列表（前端“订单信息”页）
// GET /pay/orders?page=1&pageSize=10&status=pending|paid|closed  按创建时间倒序
// 返回 { list, total, page, pageSize }
// ============================================
app.get('/orders', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id as number
    // 先把该用户已过期的 pending 单自动关闭，保证列表状态实时准确
    await closeExpiredOrders(userId)

    // 分页参数
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSizeRaw = Number(req.query.pageSize) || 10
    const pageSize = Math.min(Math.max(1, pageSizeRaw), 50)
    const status = String(req.query.status ?? '')
    const statusVal: 'pending' | 'paid' | 'closed' | undefined =
      status === 'pending' || status === 'paid' || status === 'closed' ? status : undefined

    const conds = [eq(schema.recharge_orders.userId, userId)]
    if (statusVal) conds.push(eq(schema.recharge_orders.status, statusVal))

    // 总条数（供分页）
    const countRows = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.recharge_orders)
      .where(and(...conds))
    const total = Number(countRows[0]?.total) || 0

    const rows = await db
      .select({
        orderNo: schema.recharge_orders.orderNo,
        planId: schema.recharge_orders.planId,
        amount: schema.recharge_orders.amount,
        points: schema.recharge_orders.points,
        status: schema.recharge_orders.status,
        transactionId: schema.recharge_orders.transactionId,
        paidAt: schema.recharge_orders.paidAt,
        createdAt: schema.recharge_orders.createdAt,
      })
      .from(schema.recharge_orders)
      .where(and(...conds))
      .orderBy(desc(schema.recharge_orders.createdAt), desc(schema.recharge_orders.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    return success(res, {
      list: rows.map((o) => ({ ...o, expireAt: orderExpireAt(o.createdAt).toISOString() })),
      total: Number(total) || 0,
      page,
      pageSize,
    })
  } catch (err) {
    console.error('❌ 查询订单列表失败:', err)
    return error(res, '查询订单列表失败', 500)
  }
})

// ============================================
// 查询订单状态（前端轮询）
// GET /pay/orders/:orderNo
// ============================================
app.get('/orders/:orderNo', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id as number
    const orderNo = String(req.params.orderNo ?? '')
    const [order] = await db
      .select()
      .from(schema.recharge_orders)
      .where(
        and(
          eq(schema.recharge_orders.orderNo, orderNo),
          eq(schema.recharge_orders.userId, userId),
        ),
      )
    if (!order) return error(res, '订单不存在', 404)

    // 待支付单已超过有效期 → 自动关闭，并返回最新状态
    let status = order.status
    if (status === 'pending' && orderExpireAt(order.createdAt).getTime() <= Date.now()) {
      status = 'closed'
      await db
        .update(schema.recharge_orders)
        .set({ status: 'closed', updatedAt: now() })
        .where(eq(schema.recharge_orders.orderNo, orderNo))
    }

    return success(res, {
      orderNo: order.orderNo,
      planId: order.planId,
      status,
      amount: order.amount,
      points: order.points,
      paidAt: order.paidAt,
      transactionId: order.transactionId,
      expireAt: orderExpireAt(order.createdAt).toISOString(),
    })
  } catch (err) {
    console.error('❌ 查询订单状态失败:', err)
    return error(res, '查询订单状态失败', 500)
  }
})

export default app
