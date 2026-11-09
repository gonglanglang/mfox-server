import express from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../mysqlDb";
import { success } from "../tools/response";

const app = express();

// 获取题材列表（仅上线状态，按 sort_order 排序）
app.get("/", async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.genres)
    .where(eq(schema.genres.status, "online"))
    .orderBy(schema.genres.sort_order);
  return success(res, rows);
});

export default app;
