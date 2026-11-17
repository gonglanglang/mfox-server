import { type Request, type Response, type NextFunction } from "express";
import JWT from "jsonwebtoken";
import { error } from "../tools/response";
import { RequestContext } from "@mastra/core/request-context";

import {
  BYPASS_TOKEN_SENTINEL,
  isSkipAuthEnabled,
  resolveOrCreateBypassUserId,
  verifyUserExists,
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

export interface AuthMiddlewareDeps {
  isSkipAuth?: () => boolean;
  resolveBypassUserId?: () => Promise<number>;
  userExists?: (userId: number) => Promise<boolean>;
  isTokenBlacklisted?: (token: string) => Promise<boolean>;
  verifyJwt?: (token: string) => { userId?: number } | null;
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps = {}) {
  const getSkipAuth = deps.isSkipAuth ?? isSkipAuthEnabled;
  const resolveBypassUserId = deps.resolveBypassUserId ?? resolveOrCreateBypassUserId;
  const checkUserExists = deps.userExists ?? verifyUserExists;
  const checkBlacklisted =
    deps.isTokenBlacklisted ??
    (async (token: string) => {
      try {
        const { default: redis } = await import("../redis");
        const isBlack = await redis.get(`blacklist:${token}`);
        return isBlack === "1";
      } catch {
        return false;
      }
    });
  const verifyToken =
    deps.verifyJwt ??
    ((token: string) =>
      JWT.verify(token, process.env.JWT_SECRET || "secret") as { userId?: number });

  return async function authMiddlewareHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const skipAuth = getSkipAuth();
    try {
      const { authorization } = req.headers;
      const rawToken =
        authorization && authorization.startsWith("Bearer ")
          ? authorization.slice(7).trim()
          : "";

      // 若携带了真实 JWT（非测试占位 token），优先尝试正常解析，保留原账号上下文
      if (rawToken && rawToken !== BYPASS_TOKEN_SENTINEL) {
        const blacklisted = await checkBlacklisted(rawToken);

        if (blacklisted) {
          if (!skipAuth) {
            return error(res, "token已失效，请重新登录", 401);
          }
        } else {
          try {
            const decoded = verifyToken(rawToken);
            if (decoded?.userId) {
              if (!skipAuth) {
                req.user = { id: decoded.userId };
                return next();
              }
              // 免登录测试模式下确认该 JWT 对应用户仍存在于当前库，否则自动回退到免登测试用户
              try {
                if (await checkUserExists(decoded.userId)) {
                  req.user = { id: decoded.userId };
                  return next();
                }
              } catch {
                // 数据库校验异常时走下方免登兜底解析
              }
            }
          } catch {
            if (!skipAuth) {
              return error(res, "token 无效或已过期", 401);
            }
          }
        }
      }

      // 免登录测试模式：无 token、占位 token、失效 token 或失效账号 JWT 均自动绑定测试用户放行
      if (skipAuth) {
        const bypassUserId = await resolveBypassUserId();
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
  };
}

// token权限验证（支持 SKIP_AUTH 免登录/免 Token 测试模式）
export const authMiddleware = createAuthMiddleware();
