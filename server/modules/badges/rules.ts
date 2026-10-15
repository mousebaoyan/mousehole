import { sql, type RawBuilder } from "kysely";

// The automatic badges and who has earned them; see design §8.8. Each query gives the people
// who qualify, with the floor for badges earned once per floor. Content counts when it is public,
// not anonymous, and in a public thread, wherever it came from: what the bot brought over from
// the groups too. Thresholds suit two groups of about 2000 people and can be tuned here.

export const TIERS = ["bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];
export const GROUPINGS = ["start", "likes", "answers", "persistence", "limited"] as const;
export type Grouping = (typeof GROUPINGS)[number];

export type Rule = {
  slug: string;
  name: string;
  description: string;
  tier: Tier;
  grouping: Grouping;
  multiple?: boolean;
  earned: RawBuilder<{ user_id: number; post_id: number | null }>;
};

// Floors that count, as p, with their thread as t.
const SHOWN = sql`posts p JOIN threads t ON t.id = p.thread_id
  WHERE p.status = 'visible' AND p.deleted_at IS NULL AND NOT p.anonymous
    AND t.status = 'visible' AND t.deleted_at IS NULL`;

function people(query: RawBuilder<unknown>) {
  return sql<{ user_id: number; post_id: null }>`SELECT DISTINCT user_id, NULL::integer AS post_id
    FROM (${query}) q`;
}

// Floors (replies, or opening posts) with at least this many likes, each a badge of its own.
function likedFloors(opening: boolean, likes: number) {
  return sql<{ user_id: number; post_id: number }>`SELECT p.author_id AS user_id, p.id AS post_id
    FROM ${SHOWN} AND ${opening ? sql`p.floor = 1` : sql`p.floor > 1`} AND p.like_count >= ${likes}`;
}

// At least `floors` floors with at least `likes` likes each.
function likedOften(floors: number, likes: number) {
  return people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.like_count >= ${likes}
    GROUP BY p.author_id HAVING count(*) >= ${floors}`);
}

function accepted(answers: number) {
  return people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.accepted
    GROUP BY p.author_id HAVING count(*) >= ${answers}`);
}

// Replies in other people's positioning threads (design §8.14), each thread once.
function positioningReplies(threads: number) {
  return people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.floor > 1
      AND p.author_id <> t.author_id
      AND EXISTS (SELECT 1 FROM polls WHERE polls.thread_id = t.id AND polls.preset = 'positioning')
    GROUP BY p.author_id HAVING count(DISTINCT t.id) >= ${threads}`);
}

function streak(days: number) {
  return people(sql`SELECT id AS user_id FROM users WHERE visit_streak >= ${days}`);
}

// The seed badge goes to whoever first logs in before this, Beijing time.
export const SEED_UNTIL = new Date("2026-12-01T00:00:00+08:00");

export const RULES: Rule[] = [
  {
    slug: "first_login",
    name: "初来乍到",
    description: "第一次登录鼠洞",
    tier: "bronze",
    grouping: "start",
    earned: people(sql`SELECT id AS user_id FROM users WHERE activated_at IS NOT NULL`),
  },
  {
    slug: "profile",
    name: "自我介绍",
    description: "改过名字、头像或个性签名",
    tier: "bronze",
    grouping: "start",
    earned: people(sql`SELECT id AS user_id FROM users
      WHERE custom_name IS NOT NULL OR custom_bio IS NOT NULL OR avatar_custom`),
  },
  {
    slug: "first_like",
    name: "第一个赞",
    description: "第一次给别人留表情回应",
    tier: "bronze",
    grouping: "start",
    earned: people(sql`SELECT r.user_id FROM reactions r JOIN posts p ON p.id = r.post_id
      WHERE p.author_id <> r.user_id`),
  },
  {
    slug: "first_thread",
    name: "初次发帖",
    description: "第一次发帖",
    tier: "bronze",
    grouping: "start",
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.floor = 1`),
  },
  {
    slug: "first_reply",
    name: "初次回复",
    description: "第一次回复",
    tier: "bronze",
    grouping: "start",
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.floor > 1`),
  },
  {
    slug: "archived",
    name: "被收录",
    description: "群里的发言第一次被整理进鼠洞",
    tier: "bronze",
    grouping: "start",
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.via = 'qq'`),
  },
  {
    slug: "reader",
    name: "读者",
    description: "读完一个 50 层以上的帖子的每一层",
    tier: "bronze",
    grouping: "start",
    earned: people(sql`SELECT tu.user_id FROM thread_users tu JOIN threads t ON t.id = tu.thread_id
      WHERE t.floor_count >= 50 AND t.status = 'visible' AND t.deleted_at IS NULL
        AND tu.read_floors @> int4range(1, t.floor_count, '[]')`),
  },
  {
    slug: "welcome",
    name: "欢迎",
    description: "第一次被赞",
    tier: "bronze",
    grouping: "likes",
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.like_count > 0`),
  },
  {
    slug: "nice_reply",
    name: "不错的回复",
    description: "一层回复获 5 个赞",
    tier: "bronze",
    grouping: "likes",
    multiple: true,
    earned: likedFloors(false, 5),
  },
  {
    slug: "good_reply",
    name: "很棒的回复",
    description: "一层回复获 15 个赞",
    tier: "silver",
    grouping: "likes",
    multiple: true,
    earned: likedFloors(false, 15),
  },
  {
    slug: "great_reply",
    name: "精彩的回复",
    description: "一层回复获 30 个赞",
    tier: "gold",
    grouping: "likes",
    multiple: true,
    earned: likedFloors(false, 30),
  },
  {
    slug: "nice_thread",
    name: "不错的帖子",
    description: "主楼获 5 个赞",
    tier: "bronze",
    grouping: "likes",
    multiple: true,
    earned: likedFloors(true, 5),
  },
  {
    slug: "good_thread",
    name: "很好的帖子",
    description: "主楼获 15 个赞",
    tier: "silver",
    grouping: "likes",
    multiple: true,
    earned: likedFloors(true, 15),
  },
  {
    slug: "great_thread",
    name: "精彩的帖子",
    description: "主楼获 30 个赞",
    tier: "gold",
    grouping: "likes",
    multiple: true,
    earned: likedFloors(true, 30),
  },
  {
    slug: "appreciated",
    name: "受到赞赏",
    description: "10 层各获至少 1 个赞",
    tier: "bronze",
    grouping: "likes",
    earned: likedOften(10, 1),
  },
  {
    slug: "respected",
    name: "受人尊敬",
    description: "50 层各获至少 2 个赞",
    tier: "silver",
    grouping: "likes",
    earned: likedOften(50, 2),
  },
  {
    slug: "admired",
    name: "受人敬仰",
    description: "150 层各获至少 5 个赞",
    tier: "gold",
    grouping: "likes",
    earned: likedOften(150, 5),
  },
  {
    slug: "solved",
    name: "已解决",
    description: "回复第一次被采纳",
    tier: "bronze",
    grouping: "answers",
    earned: accepted(1),
  },
  {
    slug: "advisor",
    name: "指导顾问",
    description: "回复被采纳 10 次",
    tier: "silver",
    grouping: "answers",
    earned: accepted(10),
  },
  {
    slug: "expert",
    name: "无所不知",
    description: "回复被采纳 30 次",
    tier: "gold",
    grouping: "answers",
    earned: accepted(30),
  },
  {
    slug: "experience",
    name: "经验贴作者",
    description: "在「经验分享」发的帖子，主楼获 10 个赞",
    tier: "silver",
    grouping: "answers",
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.floor = 1
      AND p.like_count >= 10
      AND t.board_id = (SELECT id FROM boards WHERE slug = 'experience')`),
  },
  {
    slug: "positioning_helper",
    name: "定位热心人",
    description: "在 5 个别人的保研定位帖里回复过",
    tier: "bronze",
    grouping: "answers",
    earned: positioningReplies(5),
  },
  {
    slug: "positioning_guide",
    name: "定位领航员",
    description: "在 20 个别人的保研定位帖里回复过",
    tier: "silver",
    grouping: "answers",
    earned: positioningReplies(20),
  },
  {
    slug: "streak_7",
    name: "常来看看",
    description: "连续 7 天访问鼠洞",
    tier: "bronze",
    grouping: "persistence",
    earned: streak(7),
  },
  {
    slug: "streak_30",
    name: "风雨无阻",
    description: "连续 30 天访问鼠洞",
    tier: "silver",
    grouping: "persistence",
    earned: streak(30),
  },
  {
    slug: "streak_100",
    name: "百日不辍",
    description: "连续 100 天访问鼠洞",
    tier: "gold",
    grouping: "persistence",
    earned: streak(100),
  },
  {
    slug: "anniversary",
    name: "一周年",
    description: "来鼠洞满一年，这一年里发过内容",
    tier: "silver",
    grouping: "persistence",
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN}
      AND p.created_at > now() - interval '1 year'
      AND EXISTS (SELECT 1 FROM users WHERE users.id = p.author_id
        AND users.activated_at <= now() - interval '1 year')`),
  },
  {
    slug: "lucky",
    name: "幸运鼠",
    description: "抽奖中奖",
    tier: "bronze",
    grouping: "persistence",
    multiple: true,
    earned: sql`SELECT e.user_id, p.id AS post_id FROM lottery_entries e
      JOIN posts p ON p.thread_id = e.thread_id AND p.floor = 1
      WHERE e.prize IS NOT NULL`,
  },
  {
    slug: "seed",
    name: "种子用户",
    description: "鼠洞开张的头一个半月里（2026 年 11 月底以前）第一次登录",
    tier: "silver",
    grouping: "limited",
    earned: people(sql`SELECT id AS user_id FROM users WHERE activated_at < ${SEED_UNTIL}`),
  },
];
