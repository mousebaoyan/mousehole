import { sql, type RawBuilder, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";

// The admin's stats (design §10.1). Days are Beijing days; bots and the owner aren't people here.

const TODAY = sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date`;
const PEOPLE = sql<boolean>`users.role NOT IN ('bot', 'owner')`;

// Active days are kept this long, enough for a year's monthly actives.
const KEEP_DAYS = 400;

export const RANGES = [7, 30, 90, 365] as const;
export type Range = (typeof RANGES)[number];

// Where someone was active that day: on the site, or in the groups (speaking there, content
// archived from there, or acting through the bot). A day already marked for the place isn't
// written again.
export async function recordActive(
  trx: Transaction<DB>,
  userIds: number[],
  day: RawBuilder<Date>,
  where: "site" | "qq",
) {
  await sql`INSERT INTO active_days AS a (user_id, day, ${sql.ref(where)})
    SELECT unnest(${userIds}::integer[]), ${day}, true
    ON CONFLICT (user_id, day) DO UPDATE SET ${sql.ref(where)} = true
    WHERE NOT ${sql.ref(`a.${where}`)}`.execute(trx);
}

// Hourly: the reading of today and yesterday, as user_days keeps only some weeks, and today's
// member counts.
export async function summarizeDays() {
  await sql`INSERT INTO daily_stats (day, read_seconds, posts_read)
    SELECT d.day, sum(d.read_seconds), sum(d.posts_read)
    FROM user_days d JOIN users ON users.id = d.user_id
    WHERE d.day >= ${TODAY} - 1 AND ${PEOPLE}
    GROUP BY d.day
    ON CONFLICT (day) DO UPDATE
    SET read_seconds = excluded.read_seconds, posts_read = excluded.posts_read`.execute(db);
  await sql`INSERT INTO daily_stats (day, members, activated)
    SELECT ${TODAY}, count(*), count(*) FILTER (WHERE activated_at IS NOT NULL)
    FROM users WHERE member_status = 'member' AND ${PEOPLE}
    ON CONFLICT (day) DO UPDATE
    SET members = excluded.members, activated = excluded.activated`.execute(db);
}

export async function clearOldActiveDays() {
  await db
    .deleteFrom("active_days")
    .where("day", "<=", sql<Date>`${TODAY} - ${KEEP_DAYS}::integer`)
    .execute();
}

// Day by day over the range and the one before it, oldest first.
async function series(range: Range) {
  const first = sql<Date>`(${TODAY} - ${2 * range - 1}::integer)`;
  const since = sql<Date>`${first}::timestamp AT TIME ZONE 'Asia/Shanghai'`;
  // Joins to and departures from the enabled groups, each group counted on its own.
  const groupChanges = (column: "joined_at" | "left_at") => sql`
    SELECT (${sql.ref(column)} AT TIME ZONE 'Asia/Shanghai')::date AS day, count(*) AS n
    FROM group_members
    JOIN qq_groups ON qq_groups.id = group_members.group_id AND qq_groups.enabled
    JOIN users ON users.id = group_members.user_id
    WHERE ${sql.ref(column)} >= ${since} AND ${PEOPLE}
    GROUP BY 1`;
  const { rows } = await sql<{
    day: string;
    site: number;
    qq: number;
    total: number;
    members: number | null;
    activated: number | null;
    new_activated: number;
    joined: number;
    left: number;
    read_seconds: number;
    posts_read: number;
  }>`
    WITH days AS (
      SELECT generate_series(${first}, ${TODAY}, interval '1 day')::date AS day
    ), active AS (
      SELECT a.day, count(*) FILTER (WHERE a.site) AS site, count(*) FILTER (WHERE a.qq) AS qq,
        count(*) AS total
      FROM active_days a JOIN users ON users.id = a.user_id
      WHERE a.day >= ${first} AND ${PEOPLE}
      GROUP BY a.day
    ), activations AS (
      SELECT (activated_at AT TIME ZONE 'Asia/Shanghai')::date AS day, count(*) AS n
      FROM users WHERE activated_at >= ${since} AND ${PEOPLE}
      GROUP BY 1
    ), joins AS (${groupChanges("joined_at")}), leaves AS (${groupChanges("left_at")})
    SELECT days.day::text AS day,
      coalesce(active.site, 0)::integer AS site,
      coalesce(active.qq, 0)::integer AS qq,
      coalesce(active.total, 0)::integer AS total,
      daily_stats.members, daily_stats.activated,
      coalesce(activations.n, 0)::integer AS new_activated,
      coalesce(joins.n, 0)::integer AS joined,
      coalesce(leaves.n, 0)::integer AS left,
      coalesce(daily_stats.read_seconds, 0) AS read_seconds,
      coalesce(daily_stats.posts_read, 0) AS posts_read
    FROM days
    LEFT JOIN active USING (day)
    LEFT JOIN daily_stats USING (day)
    LEFT JOIN activations USING (day)
    LEFT JOIN joins USING (day)
    LEFT JOIN leaves USING (day)
    ORDER BY days.day`.execute(db);
  return rows;
}

// People active in the 7 and 30 days up to a day.
async function reach(end: RawBuilder<Date>) {
  const { rows } = await sql<{
    wau_site: number;
    wau_qq: number;
    wau_total: number;
    mau_site: number;
    mau_qq: number;
    mau_total: number;
  }>`
    SELECT
      count(DISTINCT a.user_id) FILTER (WHERE a.site AND a.day > ${end} - 7)::integer AS wau_site,
      count(DISTINCT a.user_id) FILTER (WHERE a.qq AND a.day > ${end} - 7)::integer AS wau_qq,
      count(DISTINCT a.user_id) FILTER (WHERE a.day > ${end} - 7)::integer AS wau_total,
      count(DISTINCT a.user_id) FILTER (WHERE a.site)::integer AS mau_site,
      count(DISTINCT a.user_id) FILTER (WHERE a.qq)::integer AS mau_qq,
      count(DISTINCT a.user_id)::integer AS mau_total
    FROM active_days a JOIN users ON users.id = a.user_id
    WHERE a.day > ${end} - 30 AND a.day <= ${end} AND ${PEOPLE}`.execute(db);
  const r = rows[0];
  return {
    wau: { site: r.wau_site, qq: r.wau_qq, total: r.wau_total },
    mau: { site: r.mau_site, qq: r.mau_qq, total: r.mau_total },
  };
}

// How many of a week's cohort came to the site in the nth week after; null until it is over.
function back(n: number) {
  return sql<number | null>`CASE WHEN week + ${7 * (n + 1)}::integer <= ${TODAY}
    THEN count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM active_days a WHERE a.user_id = cohort.id AND a.site
        AND a.day >= week + ${7 * n}::integer AND a.day < week + ${7 * (n + 1)}::integer
    ))::integer END`;
}

// Who was activated in each of the last 12 weeks (from Monday), and how many of them came back
// in the 1st, 2nd, 4th and 8th week after.
async function retention() {
  const { rows } = await sql<{
    week: string;
    size: number;
    w1: number | null;
    w2: number | null;
    w4: number | null;
    w8: number | null;
  }>`
    WITH cohort AS (
      SELECT users.id, date_trunc('week', activated_at AT TIME ZONE 'Asia/Shanghai')::date AS week
      FROM users
      WHERE activated_at >= (date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai')
          - interval '11 weeks') AT TIME ZONE 'Asia/Shanghai'
        AND ${PEOPLE}
    )
    SELECT week::text AS week, count(*)::integer AS size,
      ${back(1)} AS w1, ${back(2)} AS w2, ${back(4)} AS w4, ${back(8)} AS w8
    FROM cohort GROUP BY week ORDER BY week DESC`.execute(db);
  return rows.map(({ week, size, w1, w2, w4, w8 }) => ({ week, size, back: [w1, w2, w4, w8] }));
}

type Day = Awaited<ReturnType<typeof series>>[number];

// A period's figures. Daily actives are averaged over whole days, so today counts only in the
// charts.
function summarize(period: Day[], whole: Day[], people: Awaited<ReturnType<typeof reach>>) {
  const average = (kind: "site" | "qq" | "total") =>
    whole.reduce((sum, d) => sum + d[kind], 0) / whole.length;
  const sum = (key: "new_activated" | "read_seconds" | "posts_read") =>
    period.reduce((total, d) => total + d[key], 0);
  return {
    dau: { site: average("site"), qq: average("qq"), total: average("total") },
    ...people,
    new_activated: sum("new_activated"),
    read_seconds: sum("read_seconds"),
    posts_read: sum("posts_read"),
  };
}

// Each figure over the range against the same length of time just before it.
export async function getStats(range: Range) {
  const [days, now, before, cohorts] = await Promise.all([
    series(range),
    reach(TODAY),
    reach(sql<Date>`(${TODAY} - ${range}::integer)`),
    retention(),
  ]);
  const earlier = days.slice(0, range);
  const recent = days.slice(range);
  return {
    range,
    days: recent.map(({ site, qq, total, ...d }) => ({ ...d, active: { site, qq, total } })),
    totals: {
      now: summarize(recent, recent.slice(0, -1), now),
      before: summarize(earlier, earlier, before),
    },
    retention: cohorts,
  };
}
