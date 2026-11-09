import express from "express";
import multer from "multer";
import { success, error } from "../tools/response";
import crypto from "crypto";
import { authMiddleware } from "../middleware/auth";
import { uploadBufferToOSS } from "../config/oss.config";
import { db, schema } from "../mysqlDb/index";
import { eq } from "drizzle-orm";

const app = express();

// multer: 内存存储，文件直接流转发到 OSS，不落盘
const upload = multer({ storage: multer.memoryStorage() });

// 通用文件上传
function uploadFileToOSS(file: Express.Multer.File, bucket: string = process.env.OSS_BUCKET!): Promise<string> {
    if (!file) return Promise.reject(new Error("没有上传文件"));
    if (!bucket) return Promise.reject(new Error("缺少 bucket 参数"));
    return new Promise(async (resolve, reject) => {
        const uniqueFileName = `${bucket}/${crypto.randomUUID()}_${file.originalname}`;
        try {
            resolve(await uploadBufferToOSS(uniqueFileName, file.buffer, file.mimetype));
        } catch (err: any) {
            console.error("OSS 上传失败:", err);
            reject(err);
        }
    })
}

// 上传文件
app.post("/file", authMiddleware, upload.single("file"), async (_req, res) => {
    const file = _req.file as Express.Multer.File;

    const bucket = _req.body.bucket || process.env.OSS_BUCKET;

    try {
        const url = await uploadFileToOSS(file, bucket);
        success(res, { url });
    } catch (err: any) {
        console.error("OSS 上传失败:", err);
        error(res, err.message || "上传失败");
    }
});


// 用户上传头像
app.post("/:userId/avatar", authMiddleware, upload.single("file"), async (_req, res) => {
    const file = _req.file as Express.Multer.File;
    const userId = _req.params.userId;
    if (!userId) return error(res, "缺少用户ID");

    try {
        // 上传到阿里云 OSS
        const url = await uploadFileToOSS(file, "avatar");

        // 更新数据库
        await db.update(schema.users)
            .set({ avatar: url })
            .where(eq(schema.users.id, Number(userId)));

        console.log("OSS 上传成功:", url);
        success(res, { url });
    } catch (err: any) {
        console.error("OSS 上传失败:", err);
        error(res, err.message || "上传失败");
    }
});
export default app;
