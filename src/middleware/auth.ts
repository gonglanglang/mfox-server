import { type Request, type Response, type NextFunction } from "express";
import JWT from "jsonwebtoken";
import { error } from "../tools/response";
import redis from "../redis";
import { RequestContext } from "@mastra/core/request-context";

import {
  BYPASS_TOKEN_SENTINEL,
  isSkipAuthEnabled,
  resolveOrCreateBypassUserId,
} from "../config/bypass";

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

// token权限验证（支持 SKIP_AUTH 免登录/免 Token 测试模式）
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const skipAuth = isSkipAuthEnabled();
  try {
    const { authorization } = req.headers;
    const rawToken =
      authorization && authorization.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : "";

    // 若携带了真实 JWT（非测试占位 token），优先尝试正常解析，保留原账号上下文
    if (rawToken && rawToken !== BYPASS_TOKEN_SENTINEL) {
      let blacklisted = false;
      try {
        const isBlack = await redis.get(`blacklist:${rawToken}`);
        blacklisted = isBlack === "1";
      } catch { }

      if (blacklisted) {
        if (!skipAuth) {
          return error(res, "token已失效，请重新登录", 401);
        }
      } else {
        try {
          const decoded = JWT.verify(
            rawToken,
            process.env.JWT_SECRET || "secret",
          ) as { userId: number };
          if (decoded?.userId) {
            req.user = { id: decoded.userId };
            return next();
          }
        } catch {
          if (!skipAuth) {
            return error(res, "token 无效或已过期", 401);
          }
        }
      }
    }

    // 免登录测试模式：无 token、占位 token 或过期 token 均自动绑定测试用户放行
    if (skipAuth) {
      const bypassUserId = await resolveOrCreateBypassUserId();
      req.user = { id: bypassUserId };
      return next();
    }

    return error(res, "未登录", 401);
  } catch (e: any) {
    if (skipAuth) {
      return error(res, e?.message || "免登用户初始化失败", 500);
    }
    return error(res, "token 无效或已过期", 401);
  }
}
