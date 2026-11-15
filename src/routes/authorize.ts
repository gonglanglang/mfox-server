import express from "express";
import { db, schema } from "../mysqlDb/index";
import { success, error } from "../tools/response";
import { mastra } from "../mastra/index";
import crypto from "crypto";
import JWT from "jsonwebtoken";
import { XMLParser } from "fast-xml-parser";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import redis from "../redis";

const xmlParser = new XMLParser();
const app = express();
const WECHAT_TOKEN = "mytoken123";
const WECHAT_ENCODING_AES_KEY = "KBptw1nJykSjJhW616M6nUdJKofWVQx87gMtVDyyCWc";
type TokenCache = { token: string; expireAt: number };
let cachedToken: TokenCache | null = null;

function queryValue(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function sha1Sorted(values: string[]): string {
  return crypto.createHash("sha1").update(values.sort().join("")).digest("hex");
}

function getWechatAesKey(): Buffer {
  return Buffer.from(`${WECHAT_ENCODING_AES_KEY}=`, "base64");
}

function pkcs7Decode(buffer: Buffer): Buffer {
  let pad = buffer.at(-1) ?? 0;
  if (pad < 1 || pad > 32) pad = 0;
  return buffer.subarray(0, buffer.length - pad);
}

function pkcs7Encode(buffer: Buffer): Buffer {
  const blockSize = 32;
  let pad = blockSize - (buffer.length % blockSize);
  if (pad === 0) pad = blockSize;
  return Buffer.concat([buffer, Buffer.alloc(pad, pad)]);
}

function verifyWechatMsgSignature({
  encrypt,
  msgSignature,
  timestamp,
  nonce,
}: {
  encrypt: string;
  msgSignature: string;
  timestamp: string;
  nonce: string;
}) {
  if (!encrypt || !msgSignature || !timestamp || !nonce) return false;
  const signature = sha1Sorted([WECHAT_TOKEN, timestamp, nonce, encrypt]);
  return signature === msgSignature;
}

function decryptWechatMsg(encrypt: string): string {
  const aesKey = getWechatAesKey();
  if (aesKey.length !== 32) {
    throw new Error(`微信 EncodingAESKey 长度错误，解码后应为 32 字节，当前为 ${aesKey.length}`);
  }
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);

  const decrypted = pkcs7Decode(Buffer.concat([
    decipher.update(Buffer.from(encrypt, "base64")),
    decipher.final(),
  ]));

  const msgLen = decrypted.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  const xml = decrypted.subarray(msgStart, msgEnd).toString("utf-8");
  const appid = decrypted.subarray(msgEnd).toString("utf-8");

  if (!process.env.WX_APPID || appid !== process.env.WX_APPID) {
    throw new Error("微信消息 appid 校验失败");
  }

  return xml;
}

function encryptWechatMsg(xml: string, timestamp: string, nonce: string) {
  if (!process.env.WX_APPID) throw new Error("缺少 WX_APPID");

  const aesKey = getWechatAesKey();
  if (aesKey.length !== 32) {
    throw new Error(`微信 EncodingAESKey 长度错误，解码后应为 32 字节，当前为 ${aesKey.length}`);
  }
  const iv = aesKey.subarray(0, 16);
  const msg = Buffer.from(xml, "utf-8");
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(msg.length, 0);

  const plain = Buffer.concat([
    crypto.randomBytes(16),
    msgLen,
    msg,
    Buffer.from(process.env.WX_APPID, "utf-8"),
  ]);
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  cipher.setAutoPadding(false);
  const encrypt = Buffer.concat([cipher.update(pkcs7Encode(plain)), cipher.final()]).toString("base64");

  return {
    Encrypt: encrypt,
    MsgSignature: sha1Sorted([WECHAT_TOKEN, timestamp, nonce, encrypt]),
    TimeStamp: timestamp,
    Nonce: nonce,
  };
}

function encryptedReplyXml(reply: ReturnType<typeof encryptWechatMsg>): string {
  return `<xml>
  <Encrypt><![CDATA[${reply.Encrypt}]]></Encrypt>
  <MsgSignature><![CDATA[${reply.MsgSignature}]]></MsgSignature>
  <TimeStamp>${reply.TimeStamp}</TimeStamp>
  <Nonce><![CDATA[${reply.Nonce}]]></Nonce>
</xml>`;
}

function extractEncryptPayload(body: unknown): string {
  if (!body) return "";
  if (Buffer.isBuffer(body)) {
    const parsed = xmlParser.parse(body.toString("utf-8"));
    return String(parsed?.xml?.Encrypt || "").trim();
  }
  if (typeof body === "object") {
    const data = body as Record<string, any>;
    return String(data.Encrypt || data.encrypt || data.xml?.Encrypt || data.xml?.encrypt || "").trim();
  }
  return "";
}

function replyTextXml(toUserName: string, fromUserName: string, content: string): string {
  return `<xml>
  <ToUserName><![CDATA[${toUserName}]]></ToUserName>
  <FromUserName><![CDATA[${fromUserName}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${content}]]></Content>
</xml>`;
}

// 获取全局token信息
const accessToken = async function (): Promise<TokenCache> {
  if (cachedToken && Date.now() < cachedToken?.expireAt) {
    return { token: cachedToken?.token, expireAt: cachedToken?.expireAt };
  }
  console.log("公众号appID:", process.env.WX_APPID);
  const accessToken_url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${process.env.WX_APPID}&secret=${process.env.APP_SECRET}`;
  const result = await fetch(accessToken_url);
  const data = (await result.json()) as any;
  console.log("获取到全局验证信息", data);
  if (!result.ok || !data.access_token || !data.expires_in) {
    console.error("获取微信 access_token 失败:", data);
    throw new Error(data.errmsg || "获取微信 access_token 失败");
  }
  cachedToken = {
    token: data.access_token,
    expireAt: Date.now() + (data.expires_in - 300) * 1000,
  };
  return cachedToken;
};

app.get("/wechat/authorize", async (_req, res) => {
  await accessToken();
  return success(res, { message: "授权成功" });
});

// 获取授权信息二维码
app.get("/wechat/code", async (_req, res) => {
  const scene_str = crypto.randomUUID();
  // 获取token信息
  const auth = await accessToken();
  //   返回二维码连接
  const wxcode_url = `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${auth?.token}`;
  // 获取二维码ticket
  const result = await fetch(wxcode_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expire_seconds: 300,
      action_name: "QR_STR_SCENE",
      action_info: {
        scene: {
          scene_str,
        },
      },
    }),
  });

  const data = (await result.json()) as any;

  // 登记 scene_str，等待微信回调
  await redis.setex(
    `login:${scene_str}`,
    300,
    JSON.stringify({ status: "pending" }),
  ); // 存储 redis

  console.log("获取到二维码ticket:", data);

  // 通过 ticket 拼出二维码图片地址
  const qrcodeUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(data.ticket)}`;

  return success(res, { qrcodeUrl, scene_str });
});

// 轮询查询授权状态
app.get("/wechat/status", async (req, res) => {
  const { scene_str } = req.query;
  const raw = await redis.get(`login:${scene_str}`);
  if (!raw) return error(res, "expired"); // 过期返回
  return success(res, JSON.parse(raw));
  // 返回状态
});

// 用户微信授权回调
app.get("/wechat/callback", async (_req, res) => {
  const { signature, timestamp, nonce, echostr } = _req.query;
  console.log("微信回调参数:", _req.query);
  // SHA1 排序加密
  const arr = [WECHAT_TOKEN, timestamp, nonce].sort();
  const hash = crypto.createHash("sha1").update(arr.join("")).digest("hex");

  if (hash === signature) {
    return res.send(echostr); // ✅ 必须原样返回
  }

  res.send("签名验证失败");
});

// 微信关注事件推送（安全模式 JSON / 兼容 XML）
app.post("/wechat/callback", async (req, res) => {
  const msgSignature = queryValue(req.query.msg_signature);
  const timestamp = queryValue(req.query.timestamp);
  const nonce = queryValue(req.query.nonce);
  const encrypt = extractEncryptPayload(req.body);

  console.log("微信事件推送原始数据:", req.query);

  if (!verifyWechatMsgSignature({ encrypt, msgSignature, timestamp, nonce })) {
    console.warn("微信事件推送签名验证失败:", {
      hasEncrypt: Boolean(encrypt),
      hasMsgSignature: Boolean(msgSignature),
      timestamp,
      nonce,
    });
    return res.status(403).send("invalid msg_signature");
  }

  let msg: Record<string, any>;
  try {
    const xmlStr = decryptWechatMsg(encrypt);
    const parsed = xmlParser.parse(xmlStr);
    msg = parsed.xml;
  } catch (err) {
    console.error("微信事件推送解密失败:", err);
    return res.status(403).send("decrypt failed");
  }

  console.log("微信事件推送:", msg);

  const sendEncryptedReply = (content: string) => {
    const reply = replyTextXml(msg.FromUserName || "", msg.ToUserName || "", content);
    try {
      return res.type("xml").send(encryptedReplyXml(encryptWechatMsg(reply, timestamp, nonce)));
    } catch (err) {
      console.error("微信回复加密失败:", err);
      return res.status(500).send("encrypt reply failed");
    }
  };

  // 只处理关注/扫码事件
  const isSubscribe = msg.Event === "subscribe";
  const isScan = msg.Event === "SCAN";
  if (msg.MsgType !== "event" || (!isSubscribe && !isScan)) {
    return sendEncryptedReply("success");
  }

  const openid = msg.FromUserName;
  // subscribe: EventKey = "qrscene_xxx"  → 去掉前缀
  // SCAN:      EventKey = "xxx"          → 直接用
  const eventKey = String(msg.EventKey || "").replace(/^qrscene_/, "");

  if (!openid) {
    return res.status(403).send("missing openid");
  }

  try {
    const auth = await accessToken();
    // 1. 查用户，没找到就创建
    //   subscribe: 1,
    //   openid: 'oIrB72JwyfkjiPMSZvlEkRhbQfNU',
    //   nickname: '',
    //   sex: 0,
    //   language: 'zh_CN',
    //   city: '',
    //   province: '',
    //   country: '',
    //   headimgurl: '',
    //   subscribe_time: 1783414781,
    //   remark: '',
    //   groupid: 0,
    //   tagid_list: [],
    //   subscribe_scene: 'ADD_SCENE_OTHERS',
    //   qr_scene: 0,
    //   qr_scene_str: ''
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.wechatOpenid, openid));
    let userRecord = rows[0];

    if (!userRecord) {
      // 获取微信用户个人信息
      const info = (await getUserInfo(auth.token, openid)) as any;

      // 获取用户信息插入到用户表
      await db.insert(schema.users).values({
        nickname: info?.nickname || `萌小兽_${crypto.randomUUID().slice(0, 8)}`,
        avatar: info?.headimgurl || "",
        gender: info?.sex === 1 ? "male" : info?.sex === 2 ? "female" : "secret",
        wechatOpenid: openid,
        appId: process.env.WX_APPID,
        loginType: "wechat",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const newRows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.wechatOpenid, openid));
      userRecord = newRows[0];
      if (!userRecord) throw new Error("用户创建失败");
    }

    // 2. 签发 JWT
    const token = JWT.sign(
      { userId: userRecord.id },
      process.env.JWT_SECRET || "secret",
      { expiresIn: "7d" },
    );

    // 3. 更新 loginStates，前端轮询拿到 token
    if (eventKey) {
      redis.setex(
        `login:${eventKey}`,
        300,
        JSON.stringify({ status: "ok", token }),
      );
    }
    
    console.log("\x1b[35m🧸 Token测试值：\x1b[0m", token);
    console.log(
      `\x1b[32m[${new Date().toLocaleString()}] 🎉 登录成功:\x1b[0m`,
      { openid, userId: userRecord.id, eventKey },
    );
  } catch (err) {
    console.error("处理关注事件失败:", err);
    return res.status(500).send("handle event failed");
  }

  // 4. 回复微信（5 秒内必须回复）
  return sendEncryptedReply("登录成功！欢迎回来");
});

// 返回用户信息
const getUserInfo = async function (access_token: string, openid: string) {
  const userInfo_url = `https://api.weixin.qq.com/cgi-bin/user/info?access_token=${access_token}&openid=${openid}&lang=zh_CN`;
  const result = await fetch(userInfo_url);
  const text = await result.text();
  const data = JSON.parse(text);
  if (!result.ok || data.errcode) {
    throw new Error(data.errmsg || "获取微信用户信息失败");
  }
  return data;
};

// 测试登录（开发用）：按 wechatOpenid 直接签发 token，跳过微信扫码
app.post("/test-login", async (req, res) => {
  const { wechatOpenid } = req.body;
  if (!wechatOpenid) return error(res, "缺少 wechatOpenid");

  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.wechatOpenid, wechatOpenid))
    .limit(1);
  if (!user) return error(res, "未找到该微信用户");

  const token = JWT.sign(
    { userId: user.id },
    process.env.JWT_SECRET || "secret",
    { expiresIn: "7d" },
  );
  return success(res, { token });
});

// 退出登录
app.post("/logout", authMiddleware, async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    // 解码拿 exp，算出剩余秒数（免登占位 token 解码为 null 时安全跳过）
    const payload = JWT.decode(token) as { exp?: number } | null;
    if (payload?.exp) {
      const ttl = payload.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        try {
          await redis.setex(`blacklist:${token}`, ttl, "1");
        } catch { }
      }
    }
  }
  return success(res, { message: "已退出" });
});

export default app;
