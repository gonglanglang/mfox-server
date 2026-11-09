import Redis from "ioredis";

// 连接参数优先取环境变量；未配置时回落到历史默认值（建议逐步迁到 .env）
const redis = new Redis({
  host: process.env.REDIS_HOST || "8.134.119.221",
  port: Number(process.env.REDIS_PORT) || 26379,
  password: process.env.REDIS_PASSWORD || "Xfmredis86379.",

  // 公网 Redis 必须开 keepAlive —— 这是 read ECONNRESET 的根因：
  // 链路中的 NAT / 云防火墙 / 负载均衡会把「空闲」TCP 连接静默回收（只删映射表，
  // 不发 FIN/RST），客户端完全察觉不到；等到下一次读响应才收到 RST，于是报 ECONNRESET。
  // 定期发送 TCP keepalive 探测可让连接始终被视为活跃，从根上避免这个问题。
  keepAlive: 10_000,
  // 建连超时（默认就是 10s，显式写出避免误配）
  connectTimeout: 10_000,
  // 断线重连：最多退避到 3 秒
  retryStrategy(times) {
    return Math.min(times * 200, 3000);
  },
});

let announced = false;
redis.on("ready", () => {
  if (!announced) {
    console.log("🍀 Redis 链接成功啦，缓存待命～");
    announced = true;
    return;
  }
  console.log("🍀 Redis 已重连～");
});

// 捕获连接错误避免 crash。重连期间的 ECONNRESET/EPIPE 属预期噪音，降级为 warn 且只保留关键信息
redis.on("error", (error: any) => {
  const code = error?.code || error?.message || "unknown";
  console.warn(`redis 连接错误（${code}）`);
});

export default redis;
