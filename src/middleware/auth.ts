import { type Request, type Response, type NextFunction } from "express";
import JWT from "jsonwebtoken";
import { error } from "../tools/response";
import redis from "../redis";
import { RequestContext } from "@mastra/core/request-context";

// 扩展 Express 的 Request 类型，加一个 user 字段
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        // nickname: string;
        // avatar: string;
        // openid: string;
      };
    }
  }
}

// token权限验证
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // 1. 从 Header 里拿 token
    const { authorization, accept } = req.headers
    if (!authorization || !authorization.startsWith("Bearer ")) {
      // 告知前端未登录
      if (accept?.includes("text/event-stream")) {
      }
      return error(res, "未登录", 401);
    }

    const token = authorization.slice(7); // 去掉 "Bearer " 前缀

    // 2.redis检查是否在黑名单
    try {
      const isBlack = await redis.get(`blacklist:${token}`);
      if (isBlack === "1") {
        // 查到值=1，说明在黑名单，拒绝访问
        return error(res, "token已失效，请重新登录", 401);
      }
    } catch { }

    // 2. 验证 & 解码
    const decoded = JWT.verify(token, process.env.JWT_SECRET!) as {
      userId: number;
    };

    req.user = {
      id: decoded.userId,
    };
    next(); // 放行
  } catch {
    return error(res, "token 无效或已过期", 401);
  }
}
