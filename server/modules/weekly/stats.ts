import { sql, type RawBuilder } from "kysely";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { anonymousBrief, userBriefs } from "../users/service.ts";

// A week of the forum, for the plugin's weekly poster in the groups (design §8.15). Only boards
// every member reads count: the poster goes to the whole group. People's lists leave out what
// was written anonymously; bots and the owner are never on them.

const WEEK_MS = 7 * 24 * 3600_000;
// Places on each list.
const PLACES = 5;

// Boards every member reads, as b.
const OPEN_BOARD = sql`(b.visibility = 'public' OR b.read_level = 0)`;
// Public floors in public threads of such boards, as p in t in b.
const VISIBLE = sql`p.status = 'visible' AND p.deleted_at IS NULL
  AND t.status = 'visible' AND t.deleted_at IS NULL AND ${OPEN_BOARD}`;
const SHOWN = sql`posts p JOIN threads t ON t.id = p.thread_id JOIN boards b ON b.id = t.board_id
  WHERE ${VISIBLE}`;
const PERSON = sql`p.author_id NOT IN (SELECT id FROM users WHERE role IN ('bot', 'owner'))`;

type Ranked = { id: number; count: number };

async function ranked(query: RawBuilder<Ranked>) {
  return (await query.execute(db)).rows;
}

export async function weeklyStats(until: Date) {
  const since = new Date(until.getTime() - WEEK_MS);
  const within = (column: RawBuilder<unknown>) =>
    sql`${column} >= ${since} AND ${column} < ${until}`;
  // Likes from others this week, on floors as p.
  const likes = sql`reactions r JOIN posts p ON p.id = r.post_id
    JOIN threads t ON t.id = p.thread_id JOIN boards b ON b.id = t.board_id
    WHERE ${VISIBLE} AND r.user_id <> p.author_id AND ${within(sql`r.created_at`)}`;

  const {
    rows: [overview],
  } = await sql<{
    threads: number;
    posts: number;
    archived: number;
    active: number;
    activated: number;
    badges: number;
  }>`SELECT
      (SELECT count(*)::integer FROM ${SHOWN} AND p.floor = 1
        AND ${within(sql`p.created_at`)}) AS threads,
      (SELECT count(*)::integer FROM ${SHOWN} AND p.floor > 1
        AND ${within(sql`p.created_at`)}) AS posts,
      (SELECT count(*)::integer FROM ${SHOWN} AND p.via = 'qq'
        AND ${within(sql`p.created_at`)}) AS archived,
      (SELECT count(DISTINCT p.author_id)::integer FROM ${SHOWN} AND ${PERSON}
        AND ${within(sql`p.created_at`)}) AS active,
      (SELECT count(*)::integer FROM users WHERE ${within(sql`activated_at`)}) AS activated,
      (SELECT count(*)::integer FROM user_badges WHERE ${within(sql`granted_at`)}) AS badges`.execute(
    db,
  );

  const threadLists = {
    most_liked: await ranked(sql`SELECT t.id, count(*)::integer AS count FROM ${likes}
      GROUP BY t.id ORDER BY count DESC, t.id DESC LIMIT ${PLACES}`),
    most_replied: await ranked(sql`SELECT t.id, count(*)::integer AS count FROM ${SHOWN}
      AND p.floor > 1 AND ${within(sql`p.created_at`)}
      GROUP BY t.id ORDER BY count DESC, t.id DESC LIMIT ${PLACES}`),
    // Readers who read some of it this week.
    most_read: await ranked(sql`SELECT t.id, count(*)::integer AS count FROM thread_users tu
      JOIN threads t ON t.id = tu.thread_id JOIN boards b ON b.id = t.board_id
      WHERE t.status = 'visible' AND t.deleted_at IS NULL AND ${OPEN_BOARD}
        AND tu.user_id <> t.author_id AND ${within(sql`tu.last_read_at`)}
      GROUP BY t.id ORDER BY count DESC, t.id DESC LIMIT ${PLACES}`),
  };
  const named = sql`NOT p.anonymous AND ${PERSON}`;
  const peopleLists = {
    most_liked: await ranked(sql`SELECT p.author_id AS id, count(*)::integer AS count
      FROM ${likes} AND ${named}
      GROUP BY p.author_id ORDER BY count DESC, p.author_id LIMIT ${PLACES}`),
    most_accepted: await ranked(sql`SELECT p.author_id AS id, count(*)::integer AS count
      FROM ${SHOWN} AND ${named} AND ${within(sql`p.accepted_at`)} AND p.author_id <> t.author_id
        AND p.accepted_by <> p.author_id
      GROUP BY p.author_id ORDER BY count DESC, p.author_id LIMIT ${PLACES}`),
    most_replies: await ranked(sql`SELECT p.author_id AS id, count(*)::integer AS count
      FROM ${SHOWN} AND ${named} AND p.floor > 1 AND ${within(sql`p.created_at`)}
      GROUP BY p.author_id ORDER BY count DESC, p.author_id LIMIT ${PLACES}`),
  };
  const { rows: gold } = await sql<{ user_id: number; id: number; name: string }>`
    SELECT ub.user_id, badges.id, badges.name FROM user_badges ub
    JOIN badges ON badges.id = ub.badge_id
    WHERE badges.tier = 'gold' AND ${within(sql`ub.granted_at`)}
      AND ub.user_id NOT IN (SELECT id FROM users WHERE role IN ('bot', 'owner'))
    ORDER BY ub.granted_at`.execute(db);

  const threadIds = Object.values(threadLists).flatMap((list) => list.map((t) => t.id));
  const { rows: threads } = await sql<{
    id: number;
    title: string;
    author_id: number;
    author_anonymous: boolean;
    slug: string;
    name: string;
  }>`SELECT t.id, t.title, t.author_id, t.author_anonymous, b.slug, b.name
    FROM threads t JOIN boards b ON b.id = t.board_id
    WHERE t.id = any(${threadIds}::integer[])`.execute(db);
  const thread = new Map(threads.map((t) => [t.id, t]));
  const peopleIds = [
    ...Object.values(peopleLists).flatMap((list) => list.map((p) => p.id)),
    ...gold.map((g) => g.user_id),
    ...threads.filter((t) => !t.author_anonymous).map((t) => t.author_id),
  ];
  const brief = await userBriefs(peopleIds);
  const qqs = await db
    .selectFrom("users")
    .select(["id", "qq"])
    .where("id", "=", sql<number>`any(${peopleIds}::integer[])`)
    .execute();
  const qq = new Map(qqs.map((u) => [u.id, u.qq]));
  const person = (id: number) => {
    const { display_name, avatar_url } = brief(id);
    return { id, display_name, qq: qq.get(id) ?? null, avatar_url };
  };

  const threadItem = ({ id, count }: Ranked) => {
    const t = thread.get(id);
    if (!t) throw new Error(`Thread ${id} was not looked up`);
    return {
      thread: { id, title: t.title, url: `${env.PUBLIC_URL}/t/${id}` },
      board: { slug: t.slug, name: t.name },
      author: t.author_anonymous ? anonymousBrief(1) : person(t.author_id),
      count,
    };
  };
  const personItem = ({ id, count }: Ranked) => ({ user: person(id), count });
  return {
    since,
    until,
    overview,
    threads: {
      most_liked: threadLists.most_liked.map(threadItem),
      most_replied: threadLists.most_replied.map(threadItem),
      most_read: threadLists.most_read.map(threadItem),
    },
    people: {
      most_liked: peopleLists.most_liked.map(personItem),
      most_accepted: peopleLists.most_accepted.map(personItem),
      most_replies: peopleLists.most_replies.map(personItem),
    },
    gold_badges: gold.map((g) => ({ user: person(g.user_id), badge: { id: g.id, name: g.name } })),
  };
}
