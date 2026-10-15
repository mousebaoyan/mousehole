import { sql } from "kysely";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { queueMail } from "../../platform/mail.ts";
import { getSettings } from "../../platform/settings.ts";
import { letterHtml, letterText, subjectOf } from "./letter.ts";

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
  const { weekly } = await getSettings();
  if (!weekly.enabled) return;
  const { start, end } = lastWeek(now);
  const due = new Date(end.getTime() + SEND_HOUR * HOUR_MS);
  if (now < due) return;
  const sent = await db
    .selectFrom("job_runs")
    .select("ran_at")
    .where("name", "=", SENT)
    .where("ran_at", ">=", due)
    .executeTakeFirst();
  if (sent) return;

  // Public floors that aren't anonymous, as p.
  const shown = sql`p.status = 'visible' AND p.deleted_at IS NULL AND NOT p.anonymous`;
  const { rows: people } = await sql<{
    id: number;
    qq: number;
    display_name: string;
    activated_at: Date | null;
    people_reached: number;
    reads: number;
    likes: number;
    accepted: number;
  }>`
    SELECT users.id, users.qq, users.display_name, users.activated_at, users.people_reached,
      coalesce(r.reads, 0) AS reads, coalesce(l.likes, 0) AS likes,
      coalesce(a.accepted, 0) AS accepted
    FROM users
    LEFT JOIN (SELECT user_id, sum(reads)::integer AS reads FROM user_reads
      WHERE day >= ${day(start)}::date AND day < ${day(end)}::date
      GROUP BY user_id) r ON r.user_id = users.id
    LEFT JOIN (SELECT p.author_id, count(*)::integer AS likes
      FROM reactions JOIN posts p ON p.id = reactions.post_id
      WHERE ${shown} AND reactions.user_id <> p.author_id
        AND reactions.created_at >= ${start} AND reactions.created_at < ${end}
      GROUP BY p.author_id) l ON l.author_id = users.id
    LEFT JOIN (SELECT p.author_id, count(*)::integer AS accepted FROM posts p
      WHERE ${shown} AND p.accepted_at >= ${start} AND p.accepted_at < ${end}
      GROUP BY p.author_id) a ON a.author_id = users.id
    WHERE (coalesce(r.reads, 0) >= ${weekly.min_reads} AND coalesce(l.likes, 0) >= ${weekly.min_likes}
        OR coalesce(a.accepted, 0) > 0)
      AND users.member_status = 'member' AND users.role NOT IN ('bot', 'owner')
      AND users.notify_email AND users.weekly_email AND users.qq IS NOT NULL`.execute(db);

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
    WHERE ${shown} AND t.status = 'visible' AND t.deleted_at IS NULL
      AND reactions.user_id <> p.author_id AND p.author_id = any(${ids}::integer[])
      AND reactions.created_at >= ${start} AND reactions.created_at < ${end}
    GROUP BY p.author_id, t.id, p.id
    HAVING count(*) >= ${weekly.top_likes}
    ORDER BY count(*) DESC, p.id`.execute(db);

  const mails = await Promise.all(
    people.map(async (p) => {
      const week = {
        name: p.display_name,
        activated: p.activated_at !== null,
        reads: p.reads,
        likes: p.likes,
        accepted: p.accepted,
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
        settingsUrl: `${env.PUBLIC_URL}/settings`,
      };
      return {
        address: `${p.qq}@qq.com`,
        subject: subjectOf(week),
        body: letterText(week),
        html: await letterHtml(week),
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
