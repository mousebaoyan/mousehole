import { AppError } from "./errors.ts";
import { BOT_NAME, STAFF } from "./site.ts";

// A mute or ban in force; see design §6.4. One whose time is up no longer counts.
export type Restriction = { type: "mute" | "ban"; until: Date | null } | null;

export function restrictionOf(type: string | null, until: Date | null): Restriction {
  if ((type !== "mute" && type !== "ban") || (until !== null && until <= new Date())) return null;
  return { type, until };
}

// Who a request acts as: a session's user, or for a bot the member in X-Act-As, else the
// bot's own account.
export type Viewer = {
  id: number;
  role: string;
  // The forum level, L0–L5 (design §6.6).
  level: number;
  member_status: string;
  restriction: Restriction;
};

// What a request with a bearer token adds on top of the viewer: a bot's, which may act for
// members (docs/api.md §2), or a member's own, given to their Agent (§8.1).
export type Token =
  | {
      kind: "bot";
      id: number;
      scopes: string[];
      actingAs: boolean;
      operator: { id: number; role: string } | null;
      // False when the member turned off proxying and someone else asked the bot.
      proxyAllowed: boolean;
    }
  | { kind: "member"; id: number; scopes: string[] };

// How the API refers to a user: a forum user ID, or `qq:` and a QQ number.
export type UserRef = { id: number } | { qq: number };

// Who did a write, for the audit log, and the way it came: the site, a bot, or a member's Agent.
export type Actor = {
  userId: number;
  operatorId: number | null;
  tokenId: number | null;
  via: "web" | "bot" | "agent";
  ip: string | null;
  userAgent: string | null;
};

// Token scopes, which double as the capability a route needs. Members' tokens have only the
// first three (design §6.7); `read` covers `profile`.
export const SCOPES = [
  "profile",
  "read",
  "act",
  "moderate",
  "admin",
  "sync",
  "auth",
  "events",
] as const;
export type Scope = (typeof SCOPES)[number];

const MEMBER_SCOPES = new Set<Scope>(["profile", "read", "act"]);
const WRITES = new Set<Scope>(["act", "moderate", "admin"]);
const BOT_ONLY = new Set<Scope>(["sync", "auth", "events"]);
const ROLES: Partial<Record<Scope, string[]>> = { moderate: STAFF, admin: ["admin", "owner"] };

function hasScope(scopes: string[], need: Scope) {
  return scopes.includes(need) || (need === "profile" && scopes.includes("read"));
}

// `archived`: what the bot writes carries the group messages it was archived from.
export function checkPermission(
  viewer: Viewer | null,
  token: Token | null,
  need: Scope,
  archived = false,
) {
  if (!viewer) throw new AppError(401, "unauthorized", "请先登录");
  if (token?.kind !== "bot" && BOT_ONLY.has(need)) {
    throw new AppError(403, "forbidden", "只有 bot 能调用这个接口");
  }
  if (token?.kind === "member" && !MEMBER_SCOPES.has(need)) {
    throw new AppError(403, "forbidden", "版主和管理员的操作只能在网页上做");
  }
  if (token && !hasScope(token.scopes, need)) {
    throw new AppError(403, "scope_missing", `这个 token 没有 ${need} 权限`);
  }

  if (WRITES.has(need)) {
    // What the bot archives was said in the group while they were in it.
    if (viewer.member_status === "frozen" && !(token?.kind === "bot" && archived)) {
      throw new AppError(403, "member_frozen", "账号已冻结，只能浏览");
    }
    // Banned people can't log in; this stops bots acting for them.
    if (viewer.restriction?.type === "ban") {
      throw new AppError(403, "banned", "账号已被封禁");
    }
    if (token?.kind === "bot" && !token.proxyAllowed) {
      throw new AppError(
        403,
        "proxy_disabled",
        `这位成员已关闭代发，只有本人能让${BOT_NAME} 代为操作`,
      );
    }
  }
  // Not anyone in the groups, so it neither writes nor joins in.
  if (need === "act" && viewer.role === "owner") {
    throw new AppError(403, "forbidden", "站长账号仅用于管理，不能发帖、回复或互动");
  }

  const roles = ROLES[need];
  if (roles) {
    // The bot's own account is limited by its token's scopes alone.
    if ((token?.kind !== "bot" || token.actingAs) && !roles.includes(viewer.role)) {
      throw new AppError(403, "forbidden", "没有权限");
    }
    if (token?.kind === "bot" && token.operator && !roles.includes(token.operator.role)) {
      throw new AppError(403, "operator_not_allowed", "操作人没有这个权限");
    }
  }
  return viewer;
}

// The system's settings, mail, QQ groups, bot tokens and logs are the owner's alone, on the web.
export function checkOwner(viewer: Viewer | null, token: Token | null) {
  if (!viewer) throw new AppError(401, "unauthorized", "请先登录");
  if (token || viewer.role !== "owner") throw new AppError(403, "forbidden", "只有站长能操作");
  return viewer;
}

// Who is reading, for what they may open: boards within their reach; content waiting for
// review or hidden shows to moderators, and to its author.
export type Reader = { reach: number; id: number | null; staff: boolean };

// Who may see members-only boards and what is in them; everyone else gets the public site.
export function isMember(viewer: Viewer | null, token: Token | null) {
  return viewer?.member_status === "member" && (token === null || token.scopes.includes("read"));
}

// How far into the forum someone reads (design §8.10): guests the public boards only, members
// the boards up to their level, and moderators, admins and the bot's own account all of them.
export const GUEST = -1;
export const EVERY_BOARD = 5;

export function reachOf(viewer: Viewer | null, token: Token | null) {
  if (!viewer || !isMember(viewer, token)) return GUEST;
  return STAFF.includes(viewer.role) || viewer.role === "bot" ? EVERY_BOARD : viewer.level;
}

// Muted members still read, bookmark and follow, but don't post, reply, edit, react or boost.
export function assertNotMuted(viewer: Viewer) {
  const r = viewer.restriction;
  if (r?.type !== "mute") return;
  const until = r.until
    ? `，到 ${r.until.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 解除`
    : "";
  throw new AppError(403, "muted", `你已被禁言${until}`);
}

// What a member's Agent puts up takes L3 (design §6.7); moderators and admins aren't held by it.
const AGENT_POSTING_LEVEL = 3;

export function assertAgentMayPost(viewer: Viewer, token: Token | null) {
  if (token?.kind !== "member" || viewer.level >= AGENT_POSTING_LEVEL) return;
  if (STAFF.includes(viewer.role)) return;
  throw new AppError(
    403,
    "level_required",
    `通过 Agent 发帖、回复和互动要 L${AGENT_POSTING_LEVEL} 起，你现在是 L${viewer.level}`,
  );
}
