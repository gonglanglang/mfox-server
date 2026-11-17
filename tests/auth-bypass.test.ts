import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BYPASS_TOKEN_SENTINEL,
  isSkipAuthEnabled,
  isSkipPointsEnabled,
} from "../src/config/bypass";
import { createAuthMiddleware } from "../src/middleware/auth";

function createMockRes() {
  const state: { statusCode: number; body: any } = {
    statusCode: 200,
    body: null,
  };
  const res: any = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: any) {
      state.body = payload;
      return res;
    },
  };
  return { res, state };
}

test("bypass env parsing defaults to false inside node:test and honors explicit SKIP_AUTH / SKIP_POINTS", () => {
  const prevAuth = process.env.SKIP_AUTH;
  const prevPoints = process.env.SKIP_POINTS;
  try {
    delete process.env.SKIP_AUTH;
    delete process.env.SKIP_POINTS;
    assert.equal(isSkipAuthEnabled(), false);
    assert.equal(isSkipPointsEnabled(), false);

    process.env.SKIP_AUTH = "true";
    process.env.SKIP_POINTS = "1";
    assert.equal(isSkipAuthEnabled(), true);
    assert.equal(isSkipPointsEnabled(), true);

    process.env.SKIP_AUTH = "false";
    process.env.SKIP_POINTS = "off";
    assert.equal(isSkipAuthEnabled(), false);
    assert.equal(isSkipPointsEnabled(), false);
  } finally {
    if (prevAuth === undefined) delete process.env.SKIP_AUTH;
    else process.env.SKIP_AUTH = prevAuth;
    if (prevPoints === undefined) delete process.env.SKIP_POINTS;
    else process.env.SKIP_POINTS = prevPoints;
  }
});

test("authMiddleware (SKIP_AUTH=true): missing, sentinel, expired, blacklisted, or stale-user JWT falls back to bypass user", async () => {
  const mw = createAuthMiddleware({
    isSkipAuth: () => true,
    resolveBypassUserId: async () => 7,
    userExists: async (uid) => uid === 7 || uid === 42,
    isTokenBlacklisted: async (t) => t === "blacklisted-jwt",
    verifyJwt: (t) => {
      if (t === "valid-existing-jwt") return { userId: 42 };
      if (t === "valid-deleted-user-jwt") return { userId: 9999 };
      throw new Error("jwt expired");
    },
  });

  // 1. No Authorization header -> bypass user 7
  {
    const req: any = { headers: {} };
    const { res } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true);
    assert.deepEqual(req.user, { id: 7 });
  }

  // 2. Sentinel token -> bypass user 7
  {
    const req: any = { headers: { authorization: `Bearer ${BYPASS_TOKEN_SENTINEL}` } };
    const { res } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true);
    assert.deepEqual(req.user, { id: 7 });
  }

  // 3. Valid JWT whose userStillExists (42) -> preserves user 42
  {
    const req: any = { headers: { authorization: "Bearer valid-existing-jwt" } };
    const { res } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true);
    assert.deepEqual(req.user, { id: 42 });
  }

  // 4. Valid JWT whose user was deleted / not in current DB (9999) -> falls back to bypass user 7!
  {
    const req: any = { headers: { authorization: "Bearer valid-deleted-user-jwt" } };
    const { res } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true);
    assert.deepEqual(req.user, { id: 7 });
  }

  // 5. Expired / invalid JWT -> falls back to bypass user 7
  {
    const req: any = { headers: { authorization: "Bearer expired-jwt" } };
    const { res } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true);
    assert.deepEqual(req.user, { id: 7 });
  }

  // 6. Blacklisted JWT -> falls back to bypass user 7 in skipAuth mode
  {
    const req: any = { headers: { authorization: "Bearer blacklisted-jwt" } };
    const { res } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true);
    assert.deepEqual(req.user, { id: 7 });
  }
});

test("authMiddleware (SKIP_AUTH=false): enforces strict 401 checks when skipAuth is disabled", async () => {
  const mw = createAuthMiddleware({
    isSkipAuth: () => false,
    resolveBypassUserId: async () => 7,
    userExists: async () => true,
    isTokenBlacklisted: async (t) => t === "blacklisted-jwt",
    verifyJwt: (t) => {
      if (t === "valid-jwt") return { userId: 42 };
      throw new Error("invalid signature");
    },
  });

  // Missing token -> 401
  {
    const req: any = { headers: {} };
    const { res, state } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, false);
    assert.equal(state.body?.code, 401);
  }

  // Sentinel token -> rejected with 401 in strict mode
  {
    const req: any = { headers: { authorization: `Bearer ${BYPASS_TOKEN_SENTINEL}` } };
    const { res, state } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, false);
    assert.equal(state.body?.code, 401);
  }

  // Blacklisted token -> rejected with 401
  {
    const req: any = { headers: { authorization: "Bearer blacklisted-jwt" } };
    const { res, state } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, false);
    assert.equal(state.body?.code, 401);
  }

  // Valid token -> accepted
  {
    const req: any = { headers: { authorization: "Bearer valid-jwt" } };
    const { res } = createMockRes();
    let calledNext = false;
    await mw(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true);
    assert.deepEqual(req.user, { id: 42 });
  }
});
