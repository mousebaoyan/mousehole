import { sql, type RawBuilder, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { deviceSummary } from "../auth/device.ts";

// The admin's stats (design §10.1). Days are Beijing days; bots and the owner aren't people here.

const TODAY = sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date`;
const PEOPLE = sql<boolean>`users.role NOT IN ('bot', 'owner')`;

// Active days and members' visits are kept this long, enough for a year's monthly actives;
// guests' visits for a season.
const KEEP_DAYS = 400;
const GUEST_DAYS = 90;

export const RANGES = [7, 30, 90, 365] as const;
export type Range = (typeof RANGES)[number];

// How people logged in (design §7), as the audit log keeps it.
type Login = "code" | "link" | "email";

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

// ---- Visits and bytes sent: counted in memory and written once a minute, to the day it is then.

export type Sent = "page" | "api" | "image" | "asset";

let sent = { page: 0, api: 0, image: 0, asset: 0 };

type Visit = {
  ip: string;
  user_agent: string;
  user_id: number | null;
  views: number;
  referrer: string | null;
  landing: string;
};

let visits = new Map<string, Visit>();

export function recordSent(kind: Sent, bytes: number) {
  sent[kind] += bytes;
}

// A page opened. `referrer` is the host of another site it was opened from, `landing` its path;
// the day keeps the first of each.
export function recordVisit(visit: Omit<Visit, "views">) {
  const userAgent = visit.user_agent.slice(0, 500);
  const key = `${visit.ip} ${visit.user_id ?? ""} ${userAgent}`;
  const known = visits.get(key);
  if (known) {
    known.views++;
    known.referrer ??= visit.referrer;
  } else {
    visits.set(key, { ...visit, user_agent: userAgent, views: 1 });
  }
}

export async function flushVisits() {
  const opened = [...visits.values()];
  const bytes = sent;
  visits = new Map();
  sent = { page: 0, api: 0, image: 0, asset: 0 };
  if (opened.length > 0) {
    await sql`
      INSERT INTO visits AS v (day, ip, user_agent, user_id, views, referrer, landing)
      SELECT ${TODAY}, * FROM unnest(
        ${opened.map((o) => o.ip)}::inet[],
        ${opened.map((o) => o.user_agent)}::text[],
        ${opened.map((o) => o.user_id)}::integer[],
        ${opened.map((o) => o.views)}::integer[],
        ${opened.map((o) => o.referrer)}::text[],
        ${opened.map((o) => o.landing)}::text[])
      ON CONFLICT (day, ip, user_agent, user_id) DO UPDATE
      SET views = v.views + excluded.views, referrer = coalesce(v.referrer, excluded.referrer)
    `.execute(db);
  }
  await sql`
    INSERT INTO daily_stats AS s (day, page_bytes, api_bytes, image_bytes, asset_bytes)
    VALUES (${TODAY}, ${bytes.page}, ${bytes.api}, ${bytes.image}, ${bytes.asset})
    ON CONFLICT (day) DO UPDATE
    SET page_bytes = coalesce(s.page_bytes, 0) + excluded.page_bytes,
      api_bytes = coalesce(s.api_bytes, 0) + excluded.api_bytes,
      image_bytes = coalesce(s.image_bytes, 0) + excluded.image_bytes,
      asset_bytes = coalesce(s.asset_bytes, 0) + excluded.asset_bytes`.execute(db);
}

// ---- Someone's visits, for the owner to check who used an account (design §10.1).

const VISITS_PAGE = 50;
const OTHERS = 20;

// Newest first; `next` is the offset of the following page.
export async function listVisits(userId: number, offset: number) {
  const rows = await db
    .selectFrom("visits")
    .select([sql<string>`day::text`.as("day"), "ip", "user_agent", "views"])
    .where("user_id", "=", userId)
    .orderBy("day", "desc")
    .orderBy("views", "desc")
    .offset(offset)
    .limit(VISITS_PAGE)
    .execute();
  return {
    items: rows.map((v) => ({ ...v, device: deviceSummary(v.user_agent) })),
    next: rows.length === VISITS_PAGE ? offset + VISITS_PAGE : null,
  };
}

// The other accounts seen at the addresses someone used, those sharing the most first.
export async function othersAtAddresses(userId: number) {
  const { rows } = await sql<{ user_id: number; ips: string[] }>`
    SELECT v.user_id, array_agg(DISTINCT host(v.ip) ORDER BY host(v.ip)) AS ips
    FROM visits v
    WHERE v.ip IN (SELECT ip FROM visits WHERE user_id = ${userId}) AND v.user_id <> ${userId}
    GROUP BY v.user_id
    ORDER BY count(DISTINCT v.ip) DESC, max(v.day) DESC, v.user_id
    LIMIT ${OTHERS}`.execute(db);
  return rows;
}

// A guest is an address and browser nobody signed in from that day, which leaves out the pages
// people opened before logging in.
const GUEST = sql<boolean>`v.user_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM visits m
  WHERE m.day = v.day AND m.ip = v.ip AND m.user_agent = v.user_agent AND m.user_id IS NOT NULL)`;

// Hourly: the reading and visits of today and yesterday, as user_days and guests' visits are kept
// only some weeks, and today's member counts.
export async function summarizeDays() {
  await sql`INSERT INTO daily_stats (day, read_seconds, posts_read)
    SELECT d.day, sum(d.read_seconds), sum(d.posts_read)
    FROM user_days d JOIN users ON users.id = d.user_id
    WHERE d.day >= ${TODAY} - 1 AND ${PEOPLE}
    GROUP BY d.day
    ON CONFLICT (day) DO UPDATE
    SET read_seconds = excluded.read_seconds, posts_read = excluded.posts_read`.execute(db);
  await sql`INSERT INTO daily_stats (day, guests, guest_views, member_views)
    SELECT v.day, count(*) FILTER (WHERE ${GUEST}),
      coalesce(sum(v.views) FILTER (WHERE ${GUEST}), 0),
      coalesce(sum(v.views) FILTER (WHERE v.user_id IS NOT NULL AND ${PEOPLE}), 0)
    FROM visits v LEFT JOIN users ON users.id = v.user_id
    WHERE v.day >= ${TODAY} - 1
    GROUP BY v.day
    ON CONFLICT (day) DO UPDATE
    SET guests = excluded.guests, guest_views = excluded.guest_views,
      member_views = excluded.member_views`.execute(db);
  await sql`INSERT INTO daily_stats (day, members, activated)
    SELECT ${TODAY}, count(*), count(*) FILTER (WHERE activated_at IS NOT NULL)
    FROM users WHERE member_status = 'member' AND ${PEOPLE}
    ON CONFLICT (day) DO UPDATE
    SET members = excluded.members, activated = excluded.activated`.execute(db);
}

// The day this many days before today.
function daysAgo(days: number) {
  return sql<Date>`${TODAY} - ${days}::integer`;
}

export async function clearOldStats() {
  await db.deleteFrom("active_days").where("day", "<=", daysAgo(KEEP_DAYS)).execute();
  await db
    .deleteFrom("visits")
    .where((eb) =>
      eb.or([
        eb("day", "<=", daysAgo(KEEP_DAYS)),
        eb.and([eb("user_id", "is", null), eb("day", "<=", daysAgo(GUEST_DAYS))]),
      ]),
    )
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
    guests: number | null;
    guest_views: number | null;
    member_views: number | null;
    bytes: Record<Sent, number> | null;
    logins: Record<Login, number>;
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
    ), joins AS (${groupChanges("joined_at")}), leaves AS (${groupChanges("left_at")}),
    logins AS (
      SELECT (a.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
        count(*) FILTER (WHERE a.data->>'method' = 'code') AS code,
        count(*) FILTER (WHERE a.data->>'method' = 'link') AS link,
        count(*) FILTER (WHERE a.data->>'method' = 'email') AS email
      FROM audit_logs a JOIN users ON users.id = a.actor_id
      WHERE a.action = 'auth.login' AND a.created_at >= ${since} AND ${PEOPLE}
      GROUP BY 1
    )
    SELECT days.day::text AS day,
      coalesce(active.site, 0)::integer AS site,
      coalesce(active.qq, 0)::integer AS qq,
      coalesce(active.total, 0)::integer AS total,
      daily_stats.members, daily_stats.activated,
      coalesce(activations.n, 0)::integer AS new_activated,
      coalesce(joins.n, 0)::integer AS joined,
      coalesce(leaves.n, 0)::integer AS left,
      coalesce(daily_stats.read_seconds, 0) AS read_seconds,
      coalesce(daily_stats.posts_read, 0) AS posts_read,
      daily_stats.guests, daily_stats.guest_views, daily_stats.member_views,
      CASE WHEN daily_stats.page_bytes IS NOT NULL THEN json_build_object(
        'page', daily_stats.page_bytes, 'api', daily_stats.api_bytes,
        'image', daily_stats.image_bytes, 'asset', daily_stats.asset_bytes) END AS bytes,
      json_build_object('code', coalesce(logins.code, 0), 'link', coalesce(logins.link, 0),
        'email', coalesce(logins.email, 0)) AS logins
    FROM days
    LEFT JOIN active USING (day)
    LEFT JOIN daily_stats USING (day)
    LEFT JOIN activations USING (day)
    LEFT JOIN joins USING (day)
    LEFT JOIN leaves USING (day)
    LEFT JOIN logins USING (day)
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

// The longest of the lists: sites guests came from, pages they opened first, devices.
const TOP = 10;

// Over the range: where guests came from and which page they opened first, and the devices of
// guests and members, each counted once a day.
async function sources(range: Range) {
  const since = sql<Date>`(${TODAY} - ${range - 1}::integer)`;
  const [referrers, landings, agents] = await Promise.all([
    sql<{ host: string; visits: number }>`
      SELECT v.referrer AS host, count(*)::integer AS visits
      FROM visits v WHERE v.day >= ${since} AND v.referrer IS NOT NULL AND ${GUEST}
      GROUP BY v.referrer ORDER BY visits DESC, host LIMIT ${TOP}`.execute(db),
    // A thread's page shows with its title.
    sql<{ path: string; title: string | null; visits: number }>`
      SELECT l.path, threads.title, l.visits
      FROM (
        SELECT v.landing AS path, count(*)::integer AS visits
        FROM visits v WHERE v.day >= ${since} AND ${GUEST}
        GROUP BY v.landing ORDER BY visits DESC, path LIMIT ${TOP}
      ) l
      LEFT JOIN threads ON threads.id =
        CASE WHEN l.path ~ '^/t/[0-9]{1,9}$' THEN substr(l.path, 4)::integer END
      ORDER BY l.visits DESC, l.path`.execute(db),
    sql<{ user_agent: string; guests: number; members: number }>`
      SELECT v.user_agent, count(*) FILTER (WHERE ${GUEST})::integer AS guests,
        count(DISTINCT (v.day, v.user_id))
          FILTER (WHERE v.user_id IS NOT NULL AND ${PEOPLE})::integer AS members
      FROM visits v LEFT JOIN users ON users.id = v.user_id
      WHERE v.day >= ${since}
      GROUP BY v.user_agent`.execute(db),
  ]);
  // Browser and system, so a browser's versions count together.
  const devices = (who: "guests" | "members") => {
    const counts = new Map<string, number>();
    for (const agent of agents.rows) {
      const device = deviceSummary(agent.user_agent);
      counts.set(device, (counts.get(device) ?? 0) + agent[who]);
    }
    return [...counts]
      .filter(([, count]) => count > 0)
      .map(([device, count]) => ({ device, visits: count }))
      .toSorted((a, b) => b.visits - a.visits)
      .slice(0, TOP);
  };
  return {
    referrers: referrers.rows,
    landings: landings.rows,
    devices: { guests: devices("guests"), members: devices("members") },
  };
}

// Mails of each kind over the range, the most sent first. Login codes and test mails don't tell
// when they are opened and clicked.
async function mailing(range: Range) {
  const { rows } = await sql<{
    kind: string;
    sent: number;
    dropped: number;
    opened: number | null;
    clicked: number | null;
  }>`
    SELECT kind, count(sent_at)::integer AS sent, count(dropped_at)::integer AS dropped,
      CASE WHEN kind NOT IN ('login', 'test') THEN count(opened_at)::integer END AS opened,
      CASE WHEN kind NOT IN ('login', 'test') THEN count(clicked_at)::integer END AS clicked
    FROM mail_log
    WHERE created_at >= (${TODAY} - ${range - 1}::integer)::timestamp AT TIME ZONE 'Asia/Shanghai'
    GROUP BY kind ORDER BY sent DESC, kind`.execute(db);
  return rows;
}

type Day = Awaited<ReturnType<typeof series>>[number];

// A figure recorded from some day on, averaged over the days that have it; null when none do.
function mean(values: (number | null)[]) {
  const known = values.filter((v) => v !== null);
  return known.length === 0 ? null : known.reduce((sum, v) => sum + v, 0) / known.length;
}

// A period's figures. Daily actives, visits and bytes are averaged over whole days, so today
// counts only in the charts.
function summarize(period: Day[], whole: Day[], people: Awaited<ReturnType<typeof reach>>) {
  const average = (kind: "site" | "qq" | "total") =>
    whole.reduce((sum, d) => sum + d[kind], 0) / whole.length;
  const sum = (key: "new_activated" | "read_seconds" | "posts_read") =>
    period.reduce((total, d) => total + d[key], 0);
  const bytes = whole.flatMap((d) => d.bytes ?? []);
  const perDay = (kind: Sent) => bytes.reduce((total, b) => total + b[kind], 0) / bytes.length;
  const logins = (method: Login) => period.reduce((total, d) => total + d.logins[method], 0);
  return {
    dau: { site: average("site"), qq: average("qq"), total: average("total") },
    ...people,
    new_activated: sum("new_activated"),
    read_seconds: sum("read_seconds"),
    posts_read: sum("posts_read"),
    logins: { code: logins("code"), link: logins("link"), email: logins("email") },
    guests: mean(whole.map((d) => d.guests)),
    guest_views: mean(whole.map((d) => d.guest_views)),
    member_views: mean(whole.map((d) => d.member_views)),
    bytes:
      bytes.length === 0
        ? null
        : {
            page: perDay("page"),
            api: perDay("api"),
            image: perDay("image"),
            asset: perDay("asset"),
          },
  };
}

// Each figure over the range against the same length of time just before it.
export async function getStats(range: Range) {
  const [days, now, before, cohorts, from, mail] = await Promise.all([
    series(range),
    reach(TODAY),
    reach(sql<Date>`(${TODAY} - ${range}::integer)`),
    retention(),
    sources(range),
    mailing(range),
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
    ...from,
    mail,
  };
}
