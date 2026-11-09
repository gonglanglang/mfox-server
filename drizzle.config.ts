import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const dbPort = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;

// npx drizzle-kit push 同步表结构
export default defineConfig({
  schema: './src/mysqlDb/schema.ts',   // schema 文件位置
  out: './drizzle',                      // 迁移文件输出目录
  dialect: 'mysql',
  dbCredentials: {
    host: process.env.DB_HOST!,
    ...(dbPort ? { port: dbPort } : {}),
    ...(process.env.DB_USER ? { user: process.env.DB_USER } : {}),
    ...(process.env.DB_PASSWORD ? { password: process.env.DB_PASSWORD } : {}),
    database: process.env.DB_NAME!,
  },
});
