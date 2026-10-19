import { Hono } from "hono";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import type { AppEnv } from "../../platform/http.ts";
import { countVisits } from "./routes.ts";
import { clearOldStats, flushVisits, summarizeDays } from "./service.ts";

const api = testClient(app).api.v1;

// The app as main.ts serves it, with stand-ins for React Router's pages, their data and the
// built files.
const server = new Hono<AppEnv>()
  .use(countVisits(new Set(["routes/thread-floors"])))
  .route("/", app)
  .get("/missing", (c) => c.html("<p>页面不存在</p>", 404))
  .get("/assets/:file", (c) =>
    c.body("x".repeat(100), 200, { "content-type": "text/javascript", "content-length": "100" }),
  )
  .get("*", (c) =>
    c.req.path.endsWith(".data")
      ? c.body("[]", 200, { "content-type": "text/x-script" })
      : c.html("<p>页面</p>"),
  );

const PHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

let admin = as("");
let thread = 0;

beforeAll(async () => {
  const { id } = await createUser("admin");
  admin = as(await login(id));
  await api.boards.$post({ json: { slug: "visits", name: "访问" } }, admin);
  const res = await api.threads.$post(
    { json: { board: "visits", title: "从外面点进来的帖子", content: { markdown: "正文" } } },
    admin,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  thread = (await res.json()).id;
});

async function open(path: string, ip: string, userAgent: string, headers = {}) {
  const res = await server.request(path, {
    headers: { "x-real-ip": ip, "user-agent": userAgent, ...headers },
  });
  return (await res.arrayBuffer()).byteLength;
}

function visitsFrom(ip: string) {
  return db
    .selectFrom("visits")
    .select(["user_id", "views", "referrer", "landing"])
    .where("ip", "=", ip)
    .orderBy("user_id")
    .execute();
}

// A Beijing day this many days back, as the database counts it.
const dayAgo = (days: number) =>
  sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date - ${days}::integer`;

// What was sent today by kind, once all counted so far is written.
async function sentToday() {
  await flushVisits();
  const row = await db
    .selectFrom("daily_stats")
    .select(["page_bytes", "api_bytes", "image_bytes", "asset_bytes"])
    .where("day", "=", dayAgo(0))
    .executeTakeFirstOrThrow();
  return {
    page: Number(row.page_bytes),
    api: Number(row.api_bytes),
    image: Number(row.image_bytes),
    asset: Number(row.asset_bytes),
  };
}

async function stats() {
  const res = await api.admin.stats.$get({ query: { range: "7" } }, admin);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("访问", () => {
  test("访客按 IP + User-Agent 每天一行，记下来源和入口；登录前的浏览不算访客", async () => {
    await summarizeDays();
    const before = (await stats()).days.at(-1);
    await open(`/t/${thread}`, "10.0.0.1", PHONE, { referer: "https://www.google.com/search?q=1" });
    await open("/b/visits.data?_routes=routes/board", "10.0.0.1", PHONE, {
      referer: `${env.PUBLIC_URL}/t/${thread}`,
    });
    const { id } = await createUser();
    const member = as(await login(id));
    await open("/", "10.0.0.2", LINUX);
    await open("/settings", "10.0.0.2", LINUX, member.headers);
    await flushVisits();

    expect(await visitsFrom("10.0.0.1")).toEqual([
      { user_id: null, views: 2, referrer: "www.google.com", landing: `/t/${thread}` },
    ]);
    expect(await visitsFrom("10.0.0.2")).toEqual([
      { user_id: id, views: 1, referrer: null, landing: "/settings" },
      { user_id: null, views: 1, referrer: null, landing: "/" },
    ]);
    await summarizeDays();
    const after = await stats();
    const today = after.days.at(-1);
    expect(Number(today?.guests) - Number(before?.guests)).toBe(1);
    expect(Number(today?.guest_views) - Number(before?.guest_views)).toBe(2);
    expect(Number(today?.member_views) - Number(before?.member_views)).toBe(1);
    expect(after.referrers).toContainEqual({ host: "www.google.com", visits: 1 });
    expect(after.landings).toContainEqual({
      path: `/t/${thread}`,
      title: "从外面点进来的帖子",
      visits: 1,
    });
    expect(after.devices.guests).toContainEqual({ device: "Safari · iOS", visits: 1 });
    expect(after.devices.members).toContainEqual({ device: "Firefox · Linux", visits: 1 });
  });

  test("爬虫、页面上的 fetcher、页面重新取数据和出错的页面不算浏览", async () => {
    await open(`/t/${thread}`, "10.0.0.3", "Mozilla/5.0 (compatible; Googlebot/2.1)");
    await open(`/t/${thread}`, "10.0.0.3", "ChatGPT-User/1.0");
    await open(
      `/t/${thread}/floors.data?after=5&_routes=routes/thread-floors`,
      "10.0.0.3",
      DESKTOP,
    );
    await open(`/t/${thread}.data?_routes=routes/thread`, "10.0.0.3", DESKTOP, {
      referer: `${env.PUBLIC_URL}/t/${thread}`,
    });
    await open("/missing", "10.0.0.3", DESKTOP);
    await open("/assets/app.js", "10.0.0.3", DESKTOP);
    await open("/api/v1/boards", "10.0.0.3", DESKTOP);
    await flushVisits();
    expect(await visitsFrom("10.0.0.3")).toEqual([]);

    // Navigating home from the thread fetches the home page's data.
    await open("/_root.data?_routes=routes/home", "10.0.0.3", DESKTOP, {
      referer: `${env.PUBLIC_URL}/t/${thread}`,
    });
    await flushVisits();
    expect(await visitsFrom("10.0.0.3")).toEqual([
      { user_id: null, views: 1, referrer: null, landing: "/" },
    ]);
  });

  test("按页面、接口、图片和静态文件累计发出的字节数", async () => {
    const before = await sentToday();
    const page = await open("/", "10.0.0.4", DESKTOP);
    const json = await open("/api/v1/boards", "10.0.0.4", DESKTOP);
    const image = await open("/avatars/1.webp", "10.0.0.4", DESKTOP);
    await open("/assets/app.js", "10.0.0.4", DESKTOP);
    expect(await sentToday()).toEqual({
      page: before.page + page,
      api: before.api + json,
      image: before.image + image,
      asset: before.asset + 100,
    });
  });

  test("访客的访问记录留 90 天，成员的留 400 天", async () => {
    const { id } = await createUser();
    await db
      .insertInto("visits")
      .values(
        [
          [null, 89],
          [null, 90],
          [id, 90],
          [id, 399],
          [id, 400],
        ].map(([userId, days]) => ({
          day: dayAgo(Number(days)),
          ip: "10.0.0.5",
          user_agent: DESKTOP,
          user_id: userId,
          views: Number(days),
          landing: "/",
        })),
      )
      .execute();
    await clearOldStats();
    const kept = await db
      .selectFrom("visits")
      .select("views")
      .where("ip", "=", "10.0.0.5")
      .orderBy("views")
      .execute();
    expect(kept.map((v) => v.views)).toEqual([89, 90, 399]);
  });
});
