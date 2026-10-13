import { describe, expect, test } from "vitest";
import { checkPermission, type Bot, type Scope, type Viewer } from "./access.ts";
import { AppError } from "./errors.ts";

const member: Viewer = { id: 1, role: "user", member_status: "member", restriction: null };
const moderator: Viewer = { id: 2, role: "moderator", member_status: "member", restriction: null };
const botAccount: Viewer = { id: 9, role: "bot", member_status: "member", restriction: null };

function bot(change: Partial<Bot> = {}): Bot {
  return {
    tokenId: 1,
    scopes: ["read", "act", "moderate", "admin"],
    actingAs: true,
    operator: null,
    proxyAllowed: true,
    ...change,
  };
}

function code(viewer: Viewer | null, b: Bot | null, need: Scope) {
  try {
    checkPermission(viewer, b, need);
    return "ok";
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
}

describe("权限判定", () => {
  test("没登录不能做任何事", () => {
    expect(code(null, null, "read")).toBe("unauthorized");
  });

  test("bot 只能做 token 范围内的事", () => {
    expect(code(member, bot({ scopes: ["read"] }), "act")).toBe("scope_missing");
    expect(code(member, bot({ scopes: ["read"] }), "read")).toBe("ok");
  });

  test("同步、口令登录、事件流只给 bot", () => {
    expect(code(moderator, null, "sync")).toBe("forbidden");
    expect(code(botAccount, bot({ scopes: ["sync"], actingAs: false }), "sync")).toBe("ok");
  });

  test("冻结的账号只能读", () => {
    const frozen = { ...member, member_status: "frozen" };
    expect(code(frozen, null, "act")).toBe("member_frozen");
    expect(code(frozen, bot(), "act")).toBe("member_frozen");
    expect(code(frozen, bot(), "read")).toBe("ok");
  });

  test("被封禁的人，bot 也不能代他写，读不受影响", () => {
    const banned: Viewer = { ...member, restriction: { type: "ban", until: null } };
    expect(code(banned, bot(), "act")).toBe("banned");
    expect(code(banned, bot(), "read")).toBe("ok");
  });

  test("关闭代发后别人不能让 bot 代他写，读不受影响", () => {
    expect(code(member, bot({ proxyAllowed: false }), "act")).toBe("proxy_disabled");
    expect(code(member, bot({ proxyAllowed: false }), "read")).toBe("ok");
  });

  test("代表成员时取交集：token 有 moderate，成员没有也不行", () => {
    expect(code(member, bot(), "moderate")).toBe("forbidden");
    expect(code(moderator, bot(), "moderate")).toBe("ok");
    expect(code(moderator, bot(), "admin")).toBe("forbidden");
  });

  test("bot 自己的账号只看 token 范围，带了操作人就要操作人也有权限", () => {
    const own = { actingAs: false };
    expect(code(botAccount, bot(own), "moderate")).toBe("ok");
    expect(code(botAccount, bot({ ...own, operator: { id: 1, role: "user" } }), "moderate")).toBe(
      "operator_not_allowed",
    );
    expect(
      code(botAccount, bot({ ...own, operator: { id: 2, role: "moderator" } }), "moderate"),
    ).toBe("ok");
  });

  test("网页上的普通成员不能做版主的事", () => {
    expect(code(member, null, "moderate")).toBe("forbidden");
    expect(code(moderator, null, "moderate")).toBe("ok");
  });
});
