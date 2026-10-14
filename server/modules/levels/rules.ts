// Level rules without the database: what each level needs, and how far someone is from it. See
// design §6.6. The numbers are constants, to be tuned once the forum is in use.

// Counted over all time, for L1–L3.
export type Totals = {
  threads_entered: number;
  posts_read: number;
  threads_replied: number;
  likes: number;
  days_visited: number;
  read_seconds: number;
};

// Counted over the last 30 days, for L4. `clean_days` is how many of them were free of any mute
// or ban, up to 30.
export type Recent = {
  days_visited: number;
  threads_replied: number;
  posts_read: number;
  read_seconds: number;
  likes: number;
  clean_days: number;
};

export const RECENT_DAYS = 30;
// A new L4 keeps it this long whatever the last 30 days say.
export const L4_GRACE_DAYS = 14;

type Needs<Key> = [Key, number][];

// What L1, L2 and L3 need on top of the levels below.
const NEEDS: Needs<keyof Totals>[] = [
  [
    ["threads_entered", 5],
    ["posts_read", 30],
  ],
  [
    ["threads_replied", 3],
    ["likes", 1],
  ],
  [
    ["days_visited", 10],
    ["threads_replied", 10],
    ["posts_read", 100],
    ["read_seconds", 3600],
    ["likes", 10],
  ],
];

// What L4 needs in the last 30 days, on top of L3; the same keeps it.
const L4_NEEDS: Needs<keyof Recent> = [
  ["days_visited", 15],
  ["threads_replied", 15],
  ["posts_read", 200],
  ["read_seconds", 7200],
  ["likes", 20],
  ["clean_days", RECENT_DAYS],
];

const LABELS: Record<keyof Totals | keyof Recent, string> = {
  threads_entered: "进入的帖子",
  posts_read: "读过的楼层",
  threads_replied: "回复过的帖子",
  likes: "获赞",
  days_visited: "访问天数",
  read_seconds: "阅读时间",
  clean_days: "没被禁言或封禁的天数",
};

function meets<Key extends keyof Totals | keyof Recent>(
  have: Record<Key, number>,
  needs: Needs<Key>,
) {
  return needs.every(([key, need]) => have[key] >= need);
}

export function keepsL4(recent: Recent) {
  return meets(recent, L4_NEEDS);
}

// The highest level the numbers earn, up to L4; L5 is only given by admins.
export function earnedLevel(totals: Totals, recent: Recent) {
  const level = NEEDS.findIndex((needs) => !meets(totals, needs));
  if (level >= 0) return level;
  return keepsL4(recent) ? 4 : NEEDS.length;
}

function listed<Key extends keyof Totals | keyof Recent>(
  have: Record<Key, number>,
  needs: Needs<Key>,
) {
  return needs.map(([key, need]) => ({ key, label: LABELS[key], have: have[key], need }));
}

// Each requirement of a level from L1 to L4, with what someone has towards it: L1–L3 over all
// time, L4 over the last 30 days, which is also what an L4 needs to keep it.
export function requirements(level: number, totals: Totals, recent: Recent) {
  return level === 4 ? listed(recent, L4_NEEDS) : listed(totals, NEEDS[level - 1]);
}
