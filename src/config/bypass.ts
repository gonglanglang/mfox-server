/**
 * 临时测试模式开关（免登录 / 免 Token 校验 / 免积分扣费）
 *
 * 当前按测试需求默认开启（SKIP_AUTH=true, SKIP_POINTS=true）：
 * - 后续恢复正式鉴权与积分计费时，只需在 .env 中设置：
 *     SKIP_AUTH=false
 *     SKIP_POINTS=false
 * - 在 node:test 单元测试环境下默认关闭，避免影响既有计费与退款不变量单测；
 *   若单测显式设置 process.env.SKIP_AUTH / SKIP_POINTS，则以显式值为准。
 */

export const BYPASS_TOKEN_SENTINEL = "dev-bypass-token";
export const BYPASS_DISPLAY_POINTS = 99_999_999;

function parseBypassEnv(rawValue: string | undefined, defaultOutsideTest = true): boolean {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const normalized = rawValue.trim().toLowerCase();
    return normalized !== "false" && normalized !== "0" && normalized !== "off" && normalized !== "no";
  }
  if (process.env.NODE_TEST_CONTEXT) {
    return false;
  }
  return defaultOutsideTest;
}

/** 是否跳过登录与 JWT Token 强校验（测试期默认 true） */
export function isSkipAuthEnabled(): boolean {
  return parseBypassEnv(process.env.SKIP_AUTH, true);
}

/** 是否跳过模型积分扣减与余额校验（测试期默认 true） */
export function isSkipPointsEnabled(): boolean {
  return parseBypassEnv(process.env.SKIP_POINTS, true);
}

let cachedBypassUserId: number | null = null;
let inflightResolve: Promise<number> | null = null;

/** 重置缓存的免登测试用户 ID（仅供测试或运维刷新使用） */
export function resetBypassUserCache(): void {
  cachedBypassUserId = null;
  inflightResolve = null;
}

/**
 * 解析或自动创建免登录测试模式绑定的真实 users.id：
 * 1. 若配置了 TEST_USER_ID 且数据库中存在该用户，优先绑定；
 * 2. 否则复用数据库中已有的第一个正常状态用户（可直接看到已有作品/章节/角色资产，且满足所有外键约束）；
 * 3. 若新库 users 表为空，则自动插入一条默认测试用户记录并缓存其自增 ID。
 */
export async function resolveOrCreateBypassUserId(): Promise<number> {
  if (cachedBypassUserId !== null && cachedBypassUserId > 0) {
    return cachedBypassUserId;
  }
  if (inflightResolve) {
    return inflightResolve;
  }

  inflightResolve = (async () => {
    const [{ db, schema }, { asc, eq }] = await Promise.all([
      import("../mysqlDb"),
      import("drizzle-orm"),
    ]);

    const configuredId = Number(process.env.TEST_USER_ID);
    if (Number.isSafeInteger(configuredId) && configuredId > 0) {
      const [explicitUser] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, configuredId))
        .limit(1);
      if (explicitUser?.id) {
        cachedBypassUserId = explicitUser.id;
        return explicitUser.id;
      }
    }

    const [activeUser] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.status, 0))
      .orderBy(asc(schema.users.id))
      .limit(1);
    if (activeUser?.id) {
      cachedBypassUserId = activeUser.id;
      return activeUser.id;
    }

    const [anyUser] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .orderBy(asc(schema.users.id))
      .limit(1);
    if (anyUser?.id) {
      cachedBypassUserId = anyUser.id;
      return anyUser.id;
    }

    const now = new Date();
    try {
      const [inserted] = await db.insert(schema.users).values({
        nickname: "测试免登用户",
        penName: "测试创作者",
        gender: "secret",
        wechatOpenid: "dev_bypass_default_user",
        appId: "dev_bypass_app",
        loginType: "account",
        points: BYPASS_DISPLAY_POINTS,
        status: 0,
        createdAt: now,
        updatedAt: now,
      });
      const newId = Number(inserted.insertId);
      if (Number.isSafeInteger(newId) && newId > 0) {
        cachedBypassUserId = newId;
        return newId;
      }
    } catch {
      // 并发初始化命中唯一索引时回退重查
    }

    const [fallbackUser] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .orderBy(asc(schema.users.id))
      .limit(1);
    if (!fallbackUser?.id) {
      throw new Error("无法解析或创建免登录测试用户");
    }
    cachedBypassUserId = fallbackUser.id;
    return fallbackUser.id;
  })().finally(() => {
    inflightResolve = null;
  });

  return inflightResolve;
}
