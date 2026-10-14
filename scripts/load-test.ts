// The load test of design §11.4: 100 readers at once, half of them guests opening a shared link,
// the members also liking and replying now and then. Passes when the p95 response time is under
// 100ms and almost nothing fails. Run it against a local server whose demo group and content
// come from `pnpm mock-bot setup` and `pnpm mock-bot seed`, never against the real site:
//
//   pnpm load-test [--base http://localhost:3000] [--users 100] [--seconds 150]
//
// --base defaults to PUBLIC_URL and has to be the server's PUBLIC_URL, which the CSRF check
// compares with. Replies are written into the demo threads.
import { readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { env } from "../server/platform/env.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: env.PUBLIC_URL },
    users: { type: "string", default: "100" },
    seconds: { type: "string", default: "150" },
  },
});
const BASE = values.base;
const USERS = Number(values.users);
const SECONDS = Number(values.seconds);
// Readers arrive over the first 30 seconds.
const RAMP_MS = 30_000;

const BOT = {
  authorization: `Bearer ${z.object({ token: z.string() }).parse(JSON.parse(readFileSync(".mock-bot.json", "utf8"))).token}`,
};
// The demo group's ordinary members; see scripts/mock-bot.ts.
const FIRST_QQ = 910000000;
const MEMBERS = Array.from({ length: 27 }, (_, i) => FIRST_QQ + 3 + i);

const Id = z.object({ id: z.number() });
// Anonymous writers come without an ID.
const Floors = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      deleted: z.boolean(),
      author: z.object({ id: z.number().optional() }),
    }),
  ),
});

type Member = { session: string; id: number };

// Every request's time to the whole response, and how many went wrong, by the kind of request.
const results = new Map<string, { times: number[]; failed: number }>();

async function timed(name: string, path: string, init: RequestInit, expected: number) {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.text();
  const result = results.get(name) ?? { times: [], failed: 0 };
  result.times.push(performance.now() - started);
  if (res.status !== expected) result.failed++;
  results.set(name, result);
  return body;
}

// Each member signs in once through a login link, as the bot would hand them out.
async function signIn(qq: number): Promise<Member> {
  const link = await fetch(`${BASE}/api/v1/bot/auth/links`, {
    method: "POST",
    headers: { ...BOT, "x-act-as": `qq:${qq}` },
  });
  const { url } = z.object({ url: z.string() }).parse(await link.json());
  const res = await fetch(`${BASE}/api/v1/auth/link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ token: new URL(url).searchParams.get("token") }),
  });
  const session = res.headers.getSetCookie()[0].split(";")[0];
  const me = Id.parse(
    await (await fetch(`${BASE}/api/v1/me`, { headers: { cookie: session } })).json(),
  );
  return { session, id: me.id };
}

function pick<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

async function reader(index: number, members: Member[], threads: number[], until: number) {
  await wait((RAMP_MS * index) / USERS);
  for (let round = 0; Date.now() < until; round++) {
    const thread = pick(threads);
    // Guests are told apart by the address the reverse proxy passes on.
    const ip = `10.${index % 250}.${round % 250}.${Math.floor(Math.random() * 250)}`;
    const roll = Math.random();
    if (roll < 0.5) {
      const guest = { headers: { "x-real-ip": ip } };
      await timed("访客 帖子页", `/t/${thread}`, guest, 200);
      await timed("访客 首页", "/", guest, 200);
    } else {
      const me = members[index % members.length];
      const headers = { cookie: me.session, "x-real-ip": ip, origin: BASE };
      await timed("成员 帖子页", `/t/${thread}`, { headers }, 200);
      const floors = Floors.parse(
        JSON.parse(
          await timed("成员 楼层接口", `/api/v1/threads/${thread}/posts`, { headers }, 200),
        ),
      ).items.filter((p) => !p.deleted && p.author.id !== me.id);
      const json = { ...headers, "content-type": "application/json" };
      if (roll < 0.85) {
        await timed("成员 首页", "/", { headers }, 200);
      } else if (roll < 0.97 && floors.length > 0) {
        const body = JSON.stringify({ emoji: "heart" });
        const path = `/api/v1/posts/${pick(floors).id}/reaction`;
        await timed("点赞", path, { method: "PUT", headers: json, body }, 204);
      } else {
        const body = JSON.stringify({ content: { markdown: `压测回复 ${index}-${round}` } });
        const path = `/api/v1/threads/${thread}/posts`;
        await timed("回复", path, { method: "POST", headers: json, body }, 201);
      }
    }
    await wait(1000 + Math.random() * 2000);
  }
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const members = await Promise.all(MEMBERS.map(signIn));
const list = z.object({ items: z.array(Id) });
// The ones guests can open too.
const threads = list
  .parse(await (await fetch(`${BASE}/api/v1/threads`)).json())
  .items.map((t) => t.id);
console.log(`${USERS} 个读者，${SECONDS} 秒，${members.length} 个成员，${threads.length} 个帖子`);
const until = Date.now() + SECONDS * 1000;
await Promise.all(Array.from({ length: USERS }, (_, i) => reader(i, members, threads, until)));

const kinds = [...results.values()];
const all = {
  times: kinds.flatMap((r) => r.times),
  failed: kinds.reduce((sum, r) => sum + r.failed, 0),
};
for (const [name, { times, failed }] of [...results, ["合计", all] as const]) {
  const sorted = times.toSorted((a, b) => a - b);
  const [p50, p95, max] = [0.5, 0.95, 1].map((p) => percentile(sorted, p).toFixed(1));
  console.log(
    `${name.padEnd(8)} ${String(sorted.length).padStart(6)} 次  p50 ${p50}ms  p95 ${p95}ms  最长 ${max}ms  失败 ${failed}`,
  );
}
const p95 = percentile(
  all.times.toSorted((a, b) => a - b),
  0.95,
);
if (p95 >= 100 || all.failed / all.times.length > 0.01) process.exitCode = 1;
