import "dotenv/config";
import express from "express";
import cors from "cors";
import { MastraServer } from "@mastra/express";
import { mastra } from "./mastra";
import { warmupPool } from "./mysqlDb";

// 路由
import agent from "./routes/agent"; // agent配置
import visualStyles from "./routes/visual-styles"; // 画风列表
import genres from "./routes/genres"; // 题材列表
import auth from "./routes/authorize"; // 授权登录配置
import users from "./routes/users"; // 用户信息
import ossUpload from "./routes/oss-upload"; // 阿里云OSS上传配置
import works from "./routes/works"; // 我的作品（含卷/章）
import settings from "./routes/settings"; // 配置路由
import models from "./routes/models"; // AI模型列表
import pay from "./routes/pay"; // 支付路由
import pipeline from "./routes/pipeline"; // 节点化流水线路由

const app = express();
const PORT = process.env.PORT || 3000;

// 在所有路由之前
app.use(
  cors({
    origin: "*", // 允许所有来源，生产环境换成具体域名
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "aiModel"], // 设置允许的请求头
  }),
);

// Middleware
// 微信安全模式回调可能是 JSON；明文/兼容模式 XML 仍保留 raw body
app.use("/auth/wechat/callback", express.json({ type: "application/json" }));
app.use("/auth/wechat/callback", express.raw({ type: "*/*" }));
// 微信支付 v3 回调需要原始 JSON 报文做验签，同样必须在 express.json() 之前
app.use("/pay/notify", express.raw({ type: "application/json" }));
app.use(/oss/, express.json({ limit: "50mb", type: "*/*" })); // 阿里云OSS上传接口，允许大文件上传

app.use(cors());
app.use(express.json());

app.use("/agent", agent);
app.use("/visual-styles", visualStyles);
app.use("/genres", genres);
app.use("/auth", auth);
app.use("/users", users);
app.use("/oss", ossUpload);
app.use("/works", works);
app.use("/settings", settings);
app.use("/ai-models", models);
app.use("/pay", pay); // 支付路由
app.use("/pipeline", pipeline);
app.use("/api/pipeline", pipeline);

const server = new MastraServer({ app, mastra });
await server.init();

// Start server
app.listen(PORT, () => {
  console.log("\x1b[35m━━━━━━━━━━━━━━━━\x1b[0m");
  console.log("\x1b[32m🍡 Server 上线咯！\x1b[0m");
  console.log(`\x1b[96m🌐 http://localhost:${PORT}\x1b[0m`);
  console.log("\x1b[35m━━━━━━━━━━━━━━━━\x1b[0m");
});

// 【调用位置 1】启动应用前先预热数据库连接池
try {
  console.log("⏳ 正在尝试连接数据库...");
  await warmupPool();
  console.log("\x1b[36m🐹 ✅ 数据库已经连接成功\x1b[0m");
} catch (error) {
  console.error("❌数据库连接失败");
  process.exit(1); // 连接失败则终止启动
}
