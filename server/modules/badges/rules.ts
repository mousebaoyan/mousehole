import { sql, type RawBuilder } from "kysely";
import { BOUNTY_DAYS } from "../coins/rules.ts";

// The automatic badges and who has earned them; see design §8.8. Each query gives the people
// who qualify, with the floor for badges earned once per floor. Content counts when it is public,
// not anonymous, and in a public thread, wherever it came from: what the bot brought over from
// the groups too. Thresholds suit two groups of about 2000 people and can be tuned here.

export const TIERS = ["bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];
export const GROUPINGS = [
  "start",
  "likes",
  "answers",
  "activity",
  "persistence",
  "social",
  "community",
  "coins",
  "fun",
  "limited",
] as const;
export type Grouping = (typeof GROUPINGS)[number];

export type Rule = {
  slug: string;
  name: string;
  description: string;
  tier: Tier;
  grouping: Grouping;
  multiple?: boolean;
  // Nobody sees what it takes until they have it.
  hidden?: boolean;
  ladder?: Ladder;
  need?: number;
  earned: RawBuilder<{ user_id: number; post_id: number | null }>;
};

// Counts some badges come one after another along, each needing more of it.
const LADDERS = [
  "reply_likes",
  "thread_likes",
  "bookmarks",
  "floors",
  "accepted",
  "positioning",
  "read_hours",
  "threads",
  "replies",
  "likes_given",
  "streak",
  "visit_days",
  "group_days",
  "followers",
  "endorsed",
  "reports",
  "coins_earned",
  "looks",
  "badges_held",
] as const;
export type Ladder = (typeof LADDERS)[number];

// Floors that count, as p, with their thread as t.
const SHOWN = sql`posts p JOIN threads t ON t.id = p.thread_id
  WHERE p.status = 'visible' AND p.deleted_at IS NULL AND NOT p.anonymous
    AND t.status = 'visible' AND t.deleted_at IS NULL`;

function people(query: RawBuilder<unknown>) {
  return sql<{ user_id: number; post_id: null }>`SELECT DISTINCT user_id, NULL::integer AS post_id
    FROM (${query}) q`;
}

// At least `floors` floors with at least `likes` likes each.
function likedOften(floors: number, likes: number) {
  return people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.like_count >= ${likes}
    GROUP BY p.author_id HAVING count(*) >= ${floors}`);
}

// Opening posts of the threads that, as t, meet a condition, each a badge of its own.
function openingsWhere(condition: RawBuilder<unknown>) {
  return sql<{ user_id: number; post_id: number }>`SELECT p.author_id AS user_id, p.id AS post_id
    FROM ${SHOWN} AND p.floor = 1 AND ${condition}`;
}

type Measured = { user_id: number; post_id: number | null; n: number };

// What the count behind a ladder is for everyone, or for one person: a row for each, or for each
// floor of theirs when its badges are earned per floor. A badge on the ladder asks for `need` of it.
type Measure = (user?: number) => RawBuilder<Measured>;

// The same query narrowed to one person, when there is one.
function onlyFor(column: string, user: number | undefined) {
  return user === undefined ? sql`` : sql`AND ${sql.ref(column)} = ${user}`;
}

// Something about each floor (a reply, or an opening post), with the thread as t.
function eachFloor(opening: boolean, count: RawBuilder<number>): Measure {
  return (user) => sql<Measured>`SELECT p.author_id AS user_id, p.id AS post_id, ${count} AS n
    FROM ${SHOWN} AND ${opening ? sql`p.floor = 1` : sql`p.floor > 1`} ${onlyFor("p.author_id", user)}`;
}

// Replies in other people's positioning threads (design §8.14), each thread once.
const POSITIONING = sql`EXISTS (SELECT 1 FROM polls
  WHERE polls.thread_id = t.id AND polls.preset = 'positioning')`;

const MEASURES: Record<Ladder, Measure> = {
  reply_likes: eachFloor(false, sql`p.like_count`),
  thread_likes: eachFloor(true, sql`p.like_count`),
  // Besides their author's own, so a thread can't be built up by its author alone.
  bookmarks: eachFloor(
    true,
    sql`(SELECT count(*)::integer FROM thread_users tu WHERE tu.thread_id = t.id
      AND tu.bookmarked_at IS NOT NULL AND tu.user_id <> t.author_id)`,
  ),
  floors: eachFloor(
    true,
    sql`(SELECT count(*)::integer FROM posts r WHERE r.thread_id = t.id AND r.floor > 1
      AND r.status = 'visible' AND r.deleted_at IS NULL AND r.author_id <> t.author_id)`,
  ),
  // Answers to other people's questions, accepted by someone else: an asker's own reply accepted,
  // or a moderator's accepted by themselves, doesn't count (design §8.1).
  accepted: (user) => sql<Measured>`SELECT p.author_id AS user_id, NULL::integer AS post_id,
      count(*)::integer AS n
    FROM ${SHOWN} AND p.accepted_at IS NOT NULL AND p.author_id <> t.author_id
      AND p.accepted_by <> p.author_id
      ${onlyFor("p.author_id", user)}
    GROUP BY p.author_id`,
  positioning: (user) => sql<Measured>`SELECT p.author_id AS user_id, NULL::integer AS post_id,
      count(DISTINCT t.id)::integer AS n
    FROM ${SHOWN} AND p.floor > 1 AND p.author_id <> t.author_id AND ${POSITIONING}
      ${onlyFor("p.author_id", user)}
    GROUP BY p.author_id`,
  read_hours: (user) => sql<Measured>`SELECT id AS user_id, NULL::integer AS post_id,
      read_seconds / 3600 AS n
    FROM users WHERE true ${onlyFor("id", user)}`,
  threads: (user) => sql<Measured>`SELECT p.author_id AS user_id, NULL::integer AS post_id,
      count(*)::integer AS n
    FROM ${SHOWN} AND p.floor = 1 ${onlyFor("p.author_id", user)}
    GROUP BY p.author_id`,
  replies: (user) => sql<Measured>`SELECT p.author_id AS user_id, NULL::integer AS post_id,
      count(*)::integer AS n
    FROM ${SHOWN} AND p.floor > 1 ${onlyFor("p.author_id", user)}
    GROUP BY p.author_id`,
  // Floors of others they have reacted to.
  likes_given: (user) => sql<Measured>`SELECT r.user_id, NULL::integer AS post_id,
      count(*)::integer AS n
    FROM reactions r JOIN posts p ON p.id = r.post_id
    WHERE p.author_id <> r.user_id AND p.status = 'visible' AND p.deleted_at IS NULL
      ${onlyFor("r.user_id", user)}
    GROUP BY r.user_id`,
  streak: (user) => sql<Measured>`SELECT id AS user_id, NULL::integer AS post_id,
      visit_streak AS n
    FROM users WHERE true ${onlyFor("id", user)}`,
  visit_days: (user) => sql<Measured>`SELECT id AS user_id, NULL::integer AS post_id,
      days_visited AS n
    FROM users WHERE true ${onlyFor("id", user)}`,
  // Days in the group of the forum they have been in longest, while still in one.
  group_days: (user) => sql<Measured>`SELECT m.user_id, NULL::integer AS post_id,
      floor(extract(epoch FROM now() - min(m.joined_at)) / 86400)::integer AS n
    FROM group_members m JOIN qq_groups g ON g.id = m.group_id
    WHERE g.enabled AND m.left_at IS NULL ${onlyFor("m.user_id", user)}
    GROUP BY m.user_id`,
  followers: (user) => sql<Measured>`SELECT followee_id AS user_id, NULL::integer AS post_id,
      count(*)::integer AS n
    FROM user_follows WHERE true ${onlyFor("followee_id", user)}
    GROUP BY followee_id`,
  endorsed: (user) => sql<Measured>`SELECT user_id, NULL::integer AS post_id, count(*)::integer AS n
    FROM endorsements WHERE true ${onlyFor("user_id", user)}
    GROUP BY user_id`,
  // Reports a moderator found right.
  reports: (user) => sql<Measured>`SELECT reporter_id AS user_id, NULL::integer AS post_id,
      count(*)::integer AS n
    FROM reports WHERE status = 'resolved' ${onlyFor("reporter_id", user)}
    GROUP BY reporter_id`,
  // What came in, not what is left.
  coins_earned: (user) => sql<Measured>`SELECT user_id, NULL::integer AS post_id,
      sum(amount)::integer AS n
    FROM coin_ledger WHERE amount > 0 ${onlyFor("user_id", user)}
    GROUP BY user_id`,
  looks: (user) => sql<Measured>`SELECT user_id, NULL::integer AS post_id, count(*)::integer AS n
    FROM coin_ledger WHERE reason = 'look' ${onlyFor("user_id", user)}
    GROUP BY user_id`,
  badges_held: (user) => sql<Measured>`SELECT user_id, NULL::integer AS post_id,
      count(DISTINCT badge_id)::integer AS n
    FROM user_badges WHERE true ${onlyFor("user_id", user)}
    GROUP BY user_id`,
};

// A badge on a ladder, earned with `need` of its count.
function counted(ladder: Ladder, need: number) {
  return {
    ladder,
    need,
    earned: sql<{ user_id: number; post_id: number | null }>`SELECT user_id, post_id
      FROM (${MEASURES[ladder]()}) m WHERE n >= ${need}`,
  };
}

// How much of each of these ladders one person has: the most any one floor has, for those earned
// per floor.
export function haveOf(user: number, wanted: readonly string[]) {
  return sql<{ ladder: string; have: number }>`${sql.join(
    LADDERS.filter((ladder) => wanted.includes(ladder)).map(
      (ladder) => sql`SELECT ${ladder}::text AS ladder, coalesce(max(n), 0)::integer AS have
        FROM (${MEASURES[ladder](user)}) m`,
    ),
    sql` UNION ALL `,
  )}`;
}

// The seed badge goes to whoever first logs in before this, Beijing time.
export const SEED_UNTIL = new Date("2026-12-01T00:00:00+08:00");

// Chinese New Year's Eve in Beijing; the next year's goes in before it comes.
const NEW_YEAR_EVES = ["2027-02-05", "2028-01-25", "2029-02-12"];

// Floors written from `from` o'clock until `to` o'clock, Beijing time.
function postedBetween(from: number, to: number) {
  return people(sql`SELECT p.author_id AS user_id FROM ${SHOWN}
    AND extract(hour FROM p.created_at AT TIME ZONE 'Asia/Shanghai') >= ${from}
    AND extract(hour FROM p.created_at AT TIME ZONE 'Asia/Shanghai') < ${to}`);
}

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
    description: "第一次给他人留表情回应",
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
    slug: "first_endorse",
    name: "慧眼识鼠",
    description: "第一次认可他人",
    tier: "bronze",
    grouping: "start",
    earned: people(sql`SELECT endorser_id AS user_id FROM endorsements`),
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
    ...counted("reply_likes", 5),
  },
  {
    slug: "good_reply",
    name: "很棒的回复",
    description: "一层回复获 15 个赞",
    tier: "silver",
    grouping: "likes",
    multiple: true,
    ...counted("reply_likes", 15),
  },
  {
    slug: "great_reply",
    name: "精彩的回复",
    description: "一层回复获 30 个赞",
    tier: "gold",
    grouping: "likes",
    multiple: true,
    ...counted("reply_likes", 30),
  },
  {
    slug: "nice_thread",
    name: "不错的帖子",
    description: "主楼获 5 个赞",
    tier: "bronze",
    grouping: "likes",
    multiple: true,
    ...counted("thread_likes", 5),
  },
  {
    slug: "good_thread",
    name: "很好的帖子",
    description: "主楼获 15 个赞",
    tier: "silver",
    grouping: "likes",
    multiple: true,
    ...counted("thread_likes", 15),
  },
  {
    slug: "great_thread",
    name: "精彩的帖子",
    description: "主楼获 30 个赞",
    tier: "gold",
    grouping: "likes",
    multiple: true,
    ...counted("thread_likes", 30),
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
    slug: "bookmarked_5",
    name: "码住了",
    description: "帖子被 5 个人收藏",
    tier: "bronze",
    grouping: "likes",
    multiple: true,
    ...counted("bookmarks", 5),
  },
  {
    slug: "bookmarked_15",
    name: "镇洞之宝",
    description: "帖子被 15 个人收藏",
    tier: "silver",
    grouping: "likes",
    multiple: true,
    ...counted("bookmarks", 15),
  },
  {
    slug: "floors_30",
    name: "盖起高楼",
    description: "帖子收到他人 30 层回复",
    tier: "bronze",
    grouping: "likes",
    multiple: true,
    ...counted("floors", 30),
  },
  {
    slug: "floors_80",
    name: "摩天大楼",
    description: "帖子收到他人 80 层回复",
    tier: "silver",
    grouping: "likes",
    multiple: true,
    ...counted("floors", 80),
  },
  {
    slug: "featured",
    name: "版主钦点",
    description: "帖子被设为精华",
    tier: "silver",
    grouping: "likes",
    multiple: true,
    earned: openingsWhere(sql`t.featured`),
  },
  {
    slug: "solved",
    name: "已解决",
    description: "回复第一次被采纳",
    tier: "bronze",
    grouping: "answers",
    ...counted("accepted", 1),
  },
  {
    slug: "advisor",
    name: "指导顾问",
    description: "回复被采纳 10 次",
    tier: "silver",
    grouping: "answers",
    ...counted("accepted", 10),
  },
  {
    slug: "expert",
    name: "无所不知",
    description: "回复被采纳 30 次",
    tier: "gold",
    grouping: "answers",
    ...counted("accepted", 30),
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
    description: "在 5 个他人的保研定位帖里回复过",
    tier: "bronze",
    grouping: "answers",
    ...counted("positioning", 5),
  },
  {
    slug: "positioning_guide",
    name: "定位领航员",
    description: "在 20 个他人的保研定位帖里回复过",
    tier: "silver",
    grouping: "answers",
    ...counted("positioning", 20),
  },
  {
    slug: "bounty_reply",
    name: "揭榜挂帅",
    description: "回复过悬赏中的问题",
    tier: "bronze",
    grouping: "answers",
    // As for the coins (design §8.19): by someone else, on the forum, while the bounty stood.
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.floor > 1
      AND p.author_id <> t.author_id AND p.via <> 'qq' AND t.bounty_at IS NOT NULL
      AND p.created_at >= t.bounty_at
      AND p.created_at < t.bounty_at + make_interval(days => ${BOUNTY_DAYS})`),
  },
  {
    slug: "hours_10",
    name: "钻书堆",
    description: "累计阅读 10 小时",
    tier: "bronze",
    grouping: "activity",
    ...counted("read_hours", 10),
  },
  {
    slug: "hours_40",
    name: "啃书鼠",
    description: "累计阅读 40 小时",
    tier: "silver",
    grouping: "activity",
    ...counted("read_hours", 40),
  },
  {
    slug: "hours_120",
    name: "卷王",
    description: "累计阅读 120 小时",
    tier: "gold",
    grouping: "activity",
    ...counted("read_hours", 120),
  },
  {
    slug: "threads_10",
    name: "笔耕鼠",
    description: "发帖 10 个",
    tier: "bronze",
    grouping: "activity",
    ...counted("threads", 10),
  },
  {
    slug: "threads_40",
    name: "著作等身",
    description: "发帖 40 个",
    tier: "silver",
    grouping: "activity",
    ...counted("threads", 40),
  },
  {
    slug: "replies_50",
    name: "话痨鼠",
    description: "回复 50 条",
    tier: "bronze",
    grouping: "activity",
    ...counted("replies", 50),
  },
  {
    slug: "replies_200",
    name: "回帖永动机",
    description: "回复 200 条",
    tier: "silver",
    grouping: "activity",
    ...counted("replies", 200),
  },
  {
    slug: "given_100",
    name: "手有余香",
    description: "给他人的 100 个楼层留过表情回应",
    tier: "bronze",
    grouping: "activity",
    ...counted("likes_given", 100),
  },
  {
    slug: "given_500",
    name: "赞不绝口",
    description: "给他人的 500 个楼层留过表情回应",
    tier: "silver",
    grouping: "activity",
    ...counted("likes_given", 500),
  },
  {
    slug: "streak_7",
    name: "常来看看",
    description: "连续 7 天访问鼠洞",
    tier: "bronze",
    grouping: "persistence",
    ...counted("streak", 7),
  },
  {
    slug: "streak_30",
    name: "风雨无阻",
    description: "连续 30 天访问鼠洞",
    tier: "silver",
    grouping: "persistence",
    ...counted("streak", 30),
  },
  {
    slug: "streak_100",
    name: "百日不辍",
    description: "连续 100 天访问鼠洞",
    tier: "gold",
    grouping: "persistence",
    ...counted("streak", 100),
  },
  {
    slug: "visits_60",
    name: "鼠洞户口",
    description: "累计访问 60 天，不要求连续",
    tier: "silver",
    grouping: "persistence",
    ...counted("visit_days", 60),
  },
  {
    slug: "visits_200",
    name: "钉子户",
    description: "累计访问 200 天，不要求连续",
    tier: "gold",
    grouping: "persistence",
    ...counted("visit_days", 200),
  },
  {
    slug: "group_1y",
    name: "老鼠",
    description: "在群里待满 1 年",
    tier: "bronze",
    grouping: "persistence",
    ...counted("group_days", 365),
  },
  {
    slug: "group_2y",
    name: "鼠中元老",
    description: "在群里待满 2 年",
    tier: "silver",
    grouping: "persistence",
    ...counted("group_days", 730),
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
    slug: "followers_10",
    name: "小有名气",
    description: "有 10 个粉丝",
    tier: "bronze",
    grouping: "social",
    ...counted("followers", 10),
  },
  {
    slug: "followers_30",
    name: "鼠群红人",
    description: "有 30 个粉丝",
    tier: "silver",
    grouping: "social",
    ...counted("followers", 30),
  },
  {
    slug: "endorsed_10",
    name: "德高望重",
    description: "获得 10 个认可",
    tier: "silver",
    grouping: "social",
    ...counted("endorsed", 10),
  },
  {
    slug: "reports_1",
    name: "鼠探",
    description: "举报被版主采纳 1 次",
    tier: "bronze",
    grouping: "community",
    ...counted("reports", 1),
  },
  {
    slug: "reports_10",
    name: "火眼金睛",
    description: "举报被版主采纳 10 次",
    tier: "silver",
    grouping: "community",
    ...counted("reports", 10),
  },
  {
    slug: "proofreader",
    name: "错别字终结者",
    description: "提的修改建议被同意",
    tier: "bronze",
    grouping: "community",
    earned: people(sql`SELECT user_id FROM thread_suggestions WHERE status = 'accepted'`),
  },
  {
    slug: "lottery_host",
    name: "散财鼠",
    description: "办过一场抽奖，已经开奖",
    tier: "bronze",
    grouping: "community",
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.floor = 1
      AND EXISTS (SELECT 1 FROM lotteries l WHERE l.thread_id = t.id AND l.drawn_at IS NOT NULL)`),
  },
  {
    slug: "poll_host",
    name: "大鼠选",
    description: "发过一个投票帖",
    tier: "bronze",
    grouping: "community",
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN} AND p.floor = 1
      AND EXISTS (SELECT 1 FROM polls WHERE polls.thread_id = t.id AND polls.preset IS NULL)`),
  },
  {
    slug: "sponsor",
    name: "投喂鼠",
    description: "赞助过鼠群，以自己的名字上了感谢墙",
    tier: "bronze",
    grouping: "community",
    // Not for anonymous ones, or the badge would tell who they were (design §8.21).
    earned: people(
      sql`SELECT user_id FROM sponsorships WHERE status = 'confirmed' AND NOT anonymous`,
    ),
  },
  {
    slug: "coins_100",
    name: "颊囊鼓鼓",
    description: "累计获得 100 鼠币",
    tier: "bronze",
    grouping: "coins",
    ...counted("coins_earned", 100),
  },
  {
    slug: "coins_400",
    name: "粮仓殷实",
    description: "累计获得 400 鼠币",
    tier: "silver",
    grouping: "coins",
    ...counted("coins_earned", 400),
  },
  {
    slug: "coins_1200",
    name: "鼠中陶朱",
    description: "累计获得 1200 鼠币",
    tier: "gold",
    grouping: "coins",
    ...counted("coins_earned", 1200),
  },
  {
    slug: "looks_1",
    name: "新衣裳",
    description: "用鼠币兑换过 1 款装扮",
    tier: "bronze",
    grouping: "coins",
    ...counted("looks", 1),
  },
  {
    slug: "looks_4",
    name: "衣橱满满",
    description: "用鼠币兑换过 4 款装扮",
    tier: "silver",
    grouping: "coins",
    ...counted("looks", 4),
  },
  {
    slug: "decorated",
    name: "精装鼠洞",
    description: "背景、头像框、主题色和展柜都设置过",
    tier: "bronze",
    grouping: "coins",
    earned: people(sql`SELECT id AS user_id FROM users WHERE background IS NOT NULL
      AND frame IS NOT NULL AND theme IS NOT NULL AND showcase IS NOT NULL`),
  },
  {
    slug: "night_owl",
    name: "夜行鼠",
    description: "北京时间凌晨 3 点到 5 点发过内容",
    tier: "bronze",
    grouping: "fun",
    hidden: true,
    earned: postedBetween(3, 5),
  },
  {
    slug: "early_bird",
    name: "早起的鼠儿",
    description: "北京时间早上 5 点到 7 点发过内容",
    tier: "bronze",
    grouping: "fun",
    hidden: true,
    earned: postedBetween(5, 7),
  },
  {
    slug: "new_year_eve",
    name: "守岁鼠",
    description: "除夕当天晚上 6 点以后发过内容",
    tier: "bronze",
    grouping: "fun",
    hidden: true,
    earned: people(sql`SELECT p.author_id AS user_id FROM ${SHOWN}
      AND (p.created_at AT TIME ZONE 'Asia/Shanghai')::date = ANY(${NEW_YEAR_EVES}::date[])
      AND extract(hour FROM p.created_at AT TIME ZONE 'Asia/Shanghai') >= 18`),
  },
  {
    slug: "badges_15",
    name: "集邮鼠",
    description: "获得 15 种徽章",
    tier: "silver",
    grouping: "fun",
    ...counted("badges_held", 15),
  },
  {
    slug: "badges_30",
    name: "博物馆馆长",
    description: "获得 30 种徽章",
    tier: "gold",
    grouping: "fun",
    ...counted("badges_held", 30),
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
