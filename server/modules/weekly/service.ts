import { sql } from "kysely";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { queueMail, unsubscribeUrl } from "../../platform/mail.ts";
import { getSettings } from "../../platform/settings.ts";
import { levelName } from "../../platform/site.ts";
import { levelProgress } from "../levels/service.ts";
import { letterHtml, letterText, subjectOf } from "./letter.ts";
import { weeklyStats } from "./stats.ts";

// The weekly letters (design §8.15): on Monday from 9 o'clock, Beijing time, each member whose
// floors did enough for others last week, Monday to Sunday, hears of it by email.

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const BEIJING_MS = 8 * HOUR_MS;
const SEND_HOUR = 9;
// Floors a letter shows at most.
const TOP_FLOORS = 3;

// The week before the current one, as instants: from Monday 00:00 to the next, Beijing time.
export function lastWeek(now: Date) {
  const beijing = new Date(now.getTime() + BEIJING_MS);
  const sinceMonday = (beijing.getUTCDay() + 6) % 7;
  const end = new Date(
    Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() - sinceMonday) -
      BEIJING_MS,
  );
  return { start: new Date(end.getTime() - 7 * DAY_MS), end };
}

const SENT = "weekly_letters";

// The Beijing date of an instant, as YYYY-MM-DD.
function day(instant: Date) {
  return new Date(instant.getTime() + BEIJING_MS).toISOString().slice(0, 10);
}

// Hourly: once this week's letters are due and not yet sent, sends them.
export async function sendWeeklyLetters(now = new Date()) {
  const { weekly, notify } = await getSettings();
  if (!weekly.enabled) return;
  const { start, end } = lastWeek(now);
  const before = new Date(start.getTime() - 7 * DAY_MS);
  const due = new Date(end.getTime() + SEND_HOUR * HOUR_MS);
  if (now < due) return;
  const sent = await db
    .selectFrom("job_runs")
    .select("ran_at")
    .where("name", "=", SENT)
    .where("ran_at", ">=", due)
    .executeTakeFirst();
  if (sent) return;

  // Public floors in public threads, not anonymous, as p in t.
  const shown = sql`p.status = 'visible' AND p.deleted_at IS NULL AND NOT p.anonymous
    AND t.status = 'visible' AND t.deleted_at IS NULL`;
  const { rows: people } = await sql<{
    id: number;
    qq: number;
    display_name: string;
    activated_at: Date | null;
    people_reached: number;
    reads: number;
    likes: number;
    accepted: number;
    reads_before: number;
    likes_before: number;
    accepted_before: number;
  }>`
    SELECT users.id, users.qq, users.display_name, users.activated_at, users.people_reached,
      coalesce(r.reads, 0) AS reads, coalesce(l.likes, 0) AS likes,
      coalesce(a.accepted, 0) AS accepted, coalesce(r.reads_before, 0) AS reads_before,
      coalesce(l.likes_before, 0) AS likes_before,
      coalesce(a.accepted_before, 0) AS accepted_before
    FROM users
    LEFT JOIN (SELECT user_id,
        (sum(reads) FILTER (WHERE day >= ${day(start)}::date))::integer AS reads,
        (sum(reads) FILTER (WHERE day < ${day(start)}::date))::integer AS reads_before
      FROM user_reads WHERE day >= ${day(before)}::date AND day < ${day(end)}::date
      GROUP BY user_id) r ON r.user_id = users.id
    LEFT JOIN (SELECT p.author_id,
        (count(*) FILTER (WHERE reactions.created_at >= ${start}))::integer AS likes,
        (count(*) FILTER (WHERE reactions.created_at < ${start}))::integer AS likes_before
      FROM reactions JOIN posts p ON p.id = reactions.post_id JOIN threads t ON t.id = p.thread_id
      WHERE ${shown} AND reactions.user_id <> p.author_id
        AND reactions.created_at >= ${before} AND reactions.created_at < ${end}
      GROUP BY p.author_id) l ON l.author_id = users.id
    LEFT JOIN (SELECT p.author_id,
        (count(*) FILTER (WHERE p.accepted_at >= ${start}))::integer AS accepted,
        (count(*) FILTER (WHERE p.accepted_at < ${start}))::integer AS accepted_before
      FROM posts p JOIN threads t ON t.id = p.thread_id
      WHERE ${shown} AND p.accepted_at >= ${before} AND p.accepted_at < ${end}
        AND p.author_id <> t.author_id
      GROUP BY p.author_id) a ON a.author_id = users.id
    WHERE (coalesce(r.reads, 0) >= ${weekly.min_reads} AND coalesce(l.likes, 0) >= ${weekly.min_likes}
        OR coalesce(a.accepted, 0) > 0)
      AND users.member_status = 'member' AND users.role NOT IN ('bot', 'owner')
      AND users.notify_email AND users.weekly_email AND users.qq IS NOT NULL
      AND (users.activated_at IS NOT NULL OR ${notify.unactivated})`.execute(db);

  const ids = people.map((p) => p.id);
  const { rows: badges } = await sql<{ user_id: number; name: string }>`
    SELECT user_badges.user_id, badges.name FROM user_badges
    JOIN badges ON badges.id = user_badges.badge_id
    WHERE user_badges.user_id = any(${ids}::integer[])
      AND user_badges.granted_at >= ${start} AND user_badges.granted_at < ${end}
    GROUP BY user_badges.user_id, badges.name
    ORDER BY min(user_badges.granted_at)`.execute(db);
  // Floors with at least so many likes last week, the most liked first.
  const { rows: top } = await sql<{
    user_id: number;
    thread_id: number;
    title: string;
    floor: number;
    likes: number;
  }>`
    SELECT p.author_id AS user_id, t.id AS thread_id, t.title, p.floor, count(*)::integer AS likes
    FROM reactions JOIN posts p ON p.id = reactions.post_id JOIN threads t ON t.id = p.thread_id
    WHERE ${shown} AND reactions.user_id <> p.author_id AND p.author_id = any(${ids}::integer[])
      AND reactions.created_at >= ${start} AND reactions.created_at < ${end}
    GROUP BY p.author_id, t.id, p.id
    HAVING count(*) >= ${weekly.top_likes}
    ORDER BY count(*) DESC, p.id`.execute(db);

  // The same lists the weekly poster shows, over the same week.
  const lists = (await weeklyStats(end)).people;
  const ranked = [
    { label: "获赞", list: lists.most_liked },
    { label: "被采纳", list: lists.most_accepted },
    { label: "回复", list: lists.most_replies },
  ];

  const mails = await Promise.all(
    people.map(async (p) => {
      const { level, next } = await levelProgress(p.id);
      const missing = (next?.items ?? [])
        .filter((i) => i.have < i.need)
        .map((i) => ({ key: i.key, label: i.label, left: i.need - i.have }));
      const week = {
        name: p.display_name,
        activated: p.activated_at !== null,
        reads: p.reads,
        likes: p.likes,
        accepted: p.accepted,
        before: { reads: p.reads_before, likes: p.likes_before, accepted: p.accepted_before },
        places: ranked.flatMap((r) => {
          const place = r.list.findIndex((item) => item.user.id === p.id) + 1;
          return place > 0 ? [{ label: r.label, place }] : [];
        }),
        level:
          next && missing.length > 0
            ? { name: levelName(next.level), keep: next.level === level, missing }
            : null,
        badges: badges.filter((b) => b.user_id === p.id).map((b) => b.name),
        top: top
          .filter((t) => t.user_id === p.id)
          .slice(0, TOP_FLOORS)
          .map((t) => ({
            title: t.title,
            floor: t.floor,
            likes: t.likes,
            url: `${env.PUBLIC_URL}/t/${t.thread_id}${t.floor > 1 ? `?floor=${t.floor}` : ""}`,
          })),
        peopleReached: p.people_reached,
        profileUrl: `${env.PUBLIC_URL}/u/${p.id}`,
        unsubscribe: unsubscribeUrl(p.id, "weekly"),
      };
      return {
        address: `${p.qq}@qq.com`,
        subject: subjectOf(week),
        body: letterText(week),
        html: await letterHtml(week),
        unsubscribe: week.unsubscribe,
      };
    }),
  );
  await db.transaction().execute(async (trx) => {
    await queueMail(trx, mails);
    await trx
      .insertInto("job_runs")
      .values({ name: SENT, ran_at: now })
      .onConflict((oc) => oc.column("name").doUpdateSet({ ran_at: now }))
      .execute();
  });
}
