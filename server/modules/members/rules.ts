// Membership rules without the database: merging pushed records and deriving an account's
// standing from its group records. See docs/data-model.md, 成员与账号.

export type GroupRole = "owner" | "admin" | "member";

// One member as a bot pushes it: NapCat's field names, every field but user_id optional.
export type MemberRecord = {
  user_id: number;
  nickname?: string;
  card?: string;
  role?: GroupRole;
  title?: string;
  join_time?: number;
  last_sent_time?: number;
  is_robot?: boolean;
  in_group?: boolean;
  left_reason?: "leave" | "kick";
};

// A group_members row; `role` is one of GroupRole, kept as the column's type.
export type MemberRow = {
  card: string;
  role: string;
  title: string;
  joined_at: Date | null;
  last_sent_at: Date | null;
  left_at: Date | null;
  left_reason: string | null;
  observed_at: Date;
};

export type Change = "joined" | "left" | "updated" | "unchanged";

const HOUR = 60 * 60 * 1000;

function fromUnix(seconds: number) {
  return new Date(seconds * 1000);
}

function sameDate(a: Date | null, b: Date | null) {
  return a?.getTime() === b?.getTime();
}

// Applies a record on top of what is known. Missing fields keep their values; `present` says
// whether the push puts the member in the group (a full list always does).
export function mergeRecord(
  existing: MemberRow | undefined,
  record: MemberRecord,
  observedAt: Date,
  present: boolean,
): { row: MemberRow; change: Change } {
  const lastSent = record.last_sent_time;
  const row: MemberRow = {
    card: record.card ?? existing?.card ?? "",
    role: record.role ?? existing?.role ?? "member",
    title: record.title ?? existing?.title ?? "",
    joined_at:
      record.join_time !== undefined ? fromUnix(record.join_time) : (existing?.joined_at ?? null),
    // Rounded to the hour, so a chatty member doesn't rewrite the row on every push.
    last_sent_at:
      lastSent !== undefined
        ? new Date(Math.floor((lastSent * 1000) / HOUR) * HOUR)
        : (existing?.last_sent_at ?? null),
    left_at: present ? null : (existing?.left_at ?? observedAt),
    left_reason: present ? null : (record.left_reason ?? existing?.left_reason ?? "unknown"),
    observed_at: observedAt,
  };

  const wasIn = existing ? existing.left_at === null : false;
  if (!existing || wasIn !== present) return { row, change: present ? "joined" : "left" };
  const same =
    row.card === existing.card &&
    row.role === existing.role &&
    row.title === existing.title &&
    sameDate(row.joined_at, existing.joined_at) &&
    sameDate(row.last_sent_at, existing.last_sent_at) &&
    row.left_reason === existing.left_reason;
  return { row, change: same ? "unchanged" : "updated" };
}

// A full list that would mark more than a fifth of the group as gone waits for the next full
// list to say the same: NapCat now and then returns a partial list.
export function shouldHold(current: number, missing: number, heldLastTime: boolean) {
  return missing > current * 0.2 && !heldLastTime;
}

export type Account = {
  qq: number | null;
  role: string;
  role_locked: boolean;
  custom_name: string | null;
  qq_nickname: string;
  display_name: string;
  member_status: string;
};

export type Membership = {
  card: string;
  role: string;
  joined_at: Date | null;
  left_at: Date | null;
  enabled: boolean;
  is_primary: boolean;
};

// Group owners run the forum, group admins moderate it.
const FORUM_ROLES = [
  ["owner", "admin"],
  ["admin", "moderator"],
] as const;

// What an account's standing follows from its group records. `isRobot` is set when this push
// said whether the account is a QQ bot.
export function deriveAccount(
  account: Account,
  memberships: Membership[],
  isRobot: boolean | undefined,
): Pick<Account, "member_status" | "role" | "display_name"> {
  const current = {
    member_status: account.member_status,
    role: account.role,
    display_name: account.display_name,
  };
  // Accounts no group knows of, like the bootstrap admin, keep what they were created with,
  // or a name they chose.
  if (memberships.length === 0) {
    return { ...current, display_name: account.custom_name ?? current.display_name };
  }

  const active = memberships.filter((m) => m.enabled && m.left_at === null);
  // The primary group speaks for the account; otherwise the group it joined first, which stays
  // put while the member chats in several.
  const chosen =
    active.find((m) => m.is_primary) ??
    active
      .toSorted(
        (a, b) => (a.joined_at?.getTime() ?? Infinity) - (b.joined_at?.getTime() ?? Infinity),
      )
      .at(0);
  const robot = isRobot ?? account.role === "bot";
  const groupRole = FORUM_ROLES.find(([group]) => active.some((m) => m.role === group))?.[1];

  return {
    member_status: active.length > 0 ? "member" : "frozen",
    role: account.role_locked ? account.role : robot ? "bot" : (groupRole ?? "user"),
    display_name:
      account.custom_name ??
      (chosen ? chosen.card || account.qq_nickname || String(account.qq) : account.display_name),
  };
}
