import express from "express";
import { db, schema } from "../mysqlDb/index";
import { success, error } from "../tools/response";
import { eq, and, isNull, or } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { DEFAULT_ASPECT_RATIO, normalizeAspectRatio } from "../config/aspect-ratios";
import { BYPASS_DISPLAY_POINTS, isSkipPointsEnabled } from "../config/bypass";

const app = express();

// 获取个人信息
app.get("/userinfo", authMiddleware, async (_req, res) => {
  const userId = _req.user?.id as number;
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!rows[0]) return error(res, "未查询到用户信息");
  const userRow = isSkipPointsEnabled()
    ? {
        ...rows[0],
        points: Math.max(Number(rows[0].points ?? 0), BYPASS_DISPLAY_POINTS),
      }
    : rows[0];
  return success(res, userRow);
});

// 更新个人信息
app.put("/userinfo", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const { nickname, penName, gender, avatar, bio, email, phone } = req.body;

  // 只更新传入的字段
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (nickname !== undefined) updates.nickname = nickname;
  if (penName !== undefined) updates.penName = penName;
  if (gender !== undefined) updates.gender = gender;
  if (avatar !== undefined) updates.avatar = avatar;
  if (bio !== undefined) updates.bio = bio;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;

  await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));

  return success(res, { message: "更新成功" });
});

// 获取用户作品列表
app.get("/works", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;

  const rows = await db
    .select()
    .from(schema.works)
    .where(and(eq(schema.works.user_id, userId), isNull(schema.works.deleted_at)));

  return success(res, rows);
});

// 创建新作品
const createWorks = async (body: any, userId: number) => {
  const { title, description, type, length, word_count, cover_url, content, audience, pov, style_id, genre, aspect_ratio } = body

  const params = {
    user_id: userId,
    title,
    description,
    type,
    cover_url,
    audience,
    pov,
    genre,
    style_id: style_id || null,
    // 视口宽高比：非法或未传时用默认值（分辨率由所选模型决定）
    aspect_ratio: normalizeAspectRatio(aspect_ratio) || DEFAULT_ASPECT_RATIO,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  console.log('添加参数', params)
  const [row] = await db.insert(schema.works).values(params);

  return { workId: row.insertId }
}
app.post("/works/create", authMiddleware, async (_req, res) => {
  const userId = _req.user?.id as number;
  const styleId = _req.body?.style_id;
  // 画风只能选官方内置或本人自定义，避免引用他人画风
  if (styleId !== undefined && styleId !== null) {
    const styleValue = Number(styleId);
    if (!Number.isSafeInteger(styleValue) || styleValue <= 0) return error(res, "无效的画风 ID");
    const [style] = await db.select({ id: schema.visualStyles.id }).from(schema.visualStyles)
      .where(and(eq(schema.visualStyles.style_id, styleValue),
        or(isNull(schema.visualStyles.user_id), eq(schema.visualStyles.user_id, userId))))
      .limit(1);
    if (!style) return error(res, "画风不存在");
  }
  return success(res, await createWorks(_req.body, userId))
})


export { createWorks }

export default app;
