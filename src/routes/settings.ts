import express from "express";
import { transitionOptions } from '../tools/storyboard-enums';
import { db, schema } from "../mysqlDb";
import { eq, and, count, desc } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { success, error } from "../tools/response";

const app = express();

export type Enums = Record<string, string[]>;
export const enums: Enums = {
    transition: transitionOptions,
    shot_size: ["极远景", "大远景", "远景", "中全景", "中景", "中近景", "近景", "特写", "大特写", "极特写"],
    camera_angle: ["正面机位", "侧面机位", "斜角机位", "仰拍机位", "俯拍机位", "顶拍机位", "过肩机位"],
    camera_movement: ["固定镜头", "推镜头", "拉镜头", "摇镜头", "移镜头", "跟镜头", "手持镜头", "升格镜头", "降格镜头", "环绕镜头"]
}

// 获取分镜枚举值
app.get('/chapter/enums', authMiddleware, async (req, res) => {
    return success(res, enums);
})

export default app;
