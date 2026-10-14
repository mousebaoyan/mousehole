import { AppError } from "./errors.ts";
import { STAFF } from "./site.ts";

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

// What a bot request adds on top of the viewer. See docs/api.md §2.
export type Bot = {
  tokenId: number;
  scopes: string[];
  actingAs: boolean;
  operator: { id: number; role: string } | null;
  // False when the member turned off proxying and someone else asked the bot.
  proxyAllowed: boolean;
};

// How the API refers to a user: a forum user ID, or `qq:` and a QQ number.
export type UserRef = { id: number } | { qq: number };

// Who did a write, for the audit log.
export type Actor = {
  userId: number;
  operatorId: number | null;
  tokenId: number | null;
  ip: string | null;
  userAgent: string | null;
};

// Bot token scopes, which double as the capability a route needs.
export const SCOPES = ["read", "act", "moderate", "admin", "sync", "auth", "events"] as const;
export type Scope = (typeof SCOPES)[number];

const WRITES = new Set<Scope>(["act", "moderate", "admin"]);
const BOT_ONLY = new Set<Scope>(["sync", "auth", "events"]);
const ROLES: Partial<Record<Scope, string[]>> = { moderate: STAFF, admin: ["admin", "owner"] };

export function checkPermission(viewer: Viewer | null, bot: Bot | null, need: Scope) {
  if (!viewer) throw new AppError(401, "unauthorized", "请先登录");
  if (bot && !bot.scopes.includes(need)) {
    throw new AppError(403, "scope_missing", `这个 token 没有 ${need} 权限`);
  }
  if (!bot && BOT_ONLY.has(need)) throw new AppError(403, "forbidden", "只有 bot 能调用这个接口");

  if (WRITES.has(need)) {
    if (viewer.member_status === "frozen") {
      throw new AppError(403, "member_frozen", "账号已冻结，只能浏览");
    }
    // Banned people can't log in; this stops bots acting for them.
    if (viewer.restriction?.type === "ban") {
      throw new AppError(403, "banned", "账号已被封禁");
    }
    if (bot && !bot.proxyAllowed) {
      throw new AppError(403, "proxy_disabled", "这位成员关闭了代发，只有本人能让 bot 操作");
    }
  }
  // Not anyone in the groups, so it neither writes nor joins in.
  if (need === "act" && viewer.role === "owner") {
    throw new AppError(403, "forbidden", "站长账号只用来管理，不能发帖、回复和互动");
  }

  const roles = ROLES[need];
  if (roles) {
    // The bot's own account is limited by its token's scopes alone.
    if ((!bot || bot.actingAs) && !roles.includes(viewer.role)) {
      throw new AppError(403, "forbidden", "没有权限");
    }
    if (bot?.operator && !roles.includes(bot.operator.role)) {
      throw new AppError(403, "operator_not_allowed", "操作人没有这个权限");
    }
  }
  return viewer;
}

// The system's settings, mail, QQ groups, bot tokens and logs are the owner's alone, on the web.
export function checkOwner(viewer: Viewer | null, bot: Bot | null) {
  if (!viewer) throw new AppError(401, "unauthorized", "请先登录");
  if (bot || viewer.role !== "owner") throw new AppError(403, "forbidden", "只有站长能操作");
  return viewer;
}

// Who is reading, for what they may open: boards within their reach; content waiting for
// review or hidden shows to moderators, and to its author.
export type Reader = { reach: number; id: number | null; staff: boolean };

// Who may see members-only boards and what is in them; everyone else gets the public site.
export function isMember(viewer: Viewer | null, bot: Bot | null) {
  return viewer?.member_status === "member" && (bot === null || bot.scopes.includes("read"));
}

// How far into the forum someone reads (design §8.10): guests the public boards only, members
// the boards up to their level, and moderators, admins and the bot's own account all of them.
export const GUEST = -1;
export const EVERY_BOARD = 5;

export function reachOf(viewer: Viewer | null, bot: Bot | null) {
  if (!viewer || !isMember(viewer, bot)) return GUEST;
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
