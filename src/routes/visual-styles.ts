import express from "express";
import { and, count, eq, isNull, max, min, or } from "drizzle-orm";
import { db, schema } from "../mysqlDb";
import { success, error } from "../tools/response";
import { authMiddleware } from "../middleware/auth";
import { isPublicHttpUrl } from "../imageTools/url-guard";

const app = express();

// 获取画风列表：官方内置（user_id 为空）+ 当前用户的自定义画风
app.get("/", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const rows = await db.select().from(schema.visualStyles)
    .where(and(
      eq(schema.visualStyles.status, 'online'),
      or(isNull(schema.visualStyles.user_id), eq(schema.visualStyles.user_id, userId)),
    ))
    .orderBy(schema.visualStyles.sort_order);
  return success(res, rows);
});

// 创建自定义画风：用户上传风格参考图（effect_image）+ 风格描述（description）
app.post("/", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const { name, description, effect_image } = req.body || {};
  const styleName = typeof name === 'string' ? name.trim() : '';
  const styleDescription = typeof description === 'string' ? description.trim() : '';
  const effectImage = typeof effect_image === 'string' ? effect_image.trim() : '';
  if (!styleName || styleName.length > 30) return error(res, '画风名称必须为 1~30 字');
  if (!styleDescription || styleDescription.length > 600) return error(res, '风格描述必须为 1~600 字');
  if (!effectImage || effectImage.length > 500 || !isPublicHttpUrl(effectImage)) return error(res, '请上传有效的风格参考图');

  // style_id 从 1000 起分配，避免与官方内置画风的固定 ID 冲突
  const [[styleMax], [sortMin]] = await Promise.all([
    db.select({ value: max(schema.visualStyles.style_id) }).from(schema.visualStyles),
    db.select({ value: min(schema.visualStyles.sort_order) }).from(schema.visualStyles),
  ]);
  const styleId = Math.max(Number(styleMax?.value || 0), 1000) + 1;
  const sortOrder = Number(sortMin?.value ?? 1) - 1; // 自定义画风排在官方之前，方便刚建完就选中
  const now = new Date();
  await db.insert(schema.visualStyles).values({
    style_id: styleId,
    name: styleName,
    type: 'custom',
    user_id: userId,
    description: styleDescription,
    effect_image: effectImage,
    status: 'online',
    sort_order: sortOrder,
    createdAt: now,
    updatedAt: now,
  } as any);
  return success(res, { style_id: styleId });
});

// 删除自定义画风：仅本人可删；仍被作品引用时拒绝，避免作品指向不存在的画风
app.delete("/:styleId", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const styleId = Number(req.params.styleId);
  if (!Number.isSafeInteger(styleId) || styleId <= 0) return error(res, '无效的画风 ID');
  const [style] = await db.select({ id: schema.visualStyles.id }).from(schema.visualStyles)
    .where(and(eq(schema.visualStyles.style_id, styleId), eq(schema.visualStyles.user_id, userId)))
    .limit(1);
  if (!style) return error(res, '画风不存在或不可删除');
  const [used] = await db.select({ value: count() }).from(schema.works)
    .where(and(eq(schema.works.style_id, styleId), isNull(schema.works.deleted_at)));
  if (Number(used?.value || 0) > 0) return error(res, `该画风仍被 ${used!.value} 个作品使用，请先更换这些作品的画风`);
  await db.delete(schema.visualStyles)
    .where(and(eq(schema.visualStyles.style_id, styleId), eq(schema.visualStyles.user_id, userId)));
  return success(res, '已删除');
});

export default app;
