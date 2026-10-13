// Stands in for the AstrBot plugin during development: pushes a fake QQ group and logs members in
// through the same HTTP API the plugin uses. Run `pnpm mock-bot` for the commands.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { createBotToken } from "../server/modules/auth/service.ts";
import { SCOPES } from "../server/platform/access.ts";
import { db } from "../server/platform/db.ts";
import { env } from "../server/platform/env.ts";

const STATE_FILE = ".mock-bot.json";
const GROUP = 100200300;
const BOT_QQ = 900000000;
const MEMBERS = 30;

const StateSchema = z.object({ token: z.string() });
const Fields = z.record(z.string(), z.unknown());

const NAMES = [
  "鼠鼠",
  "阿柒",
  "南京的鼠",
  "夜猫子",
  "海边的鼠鼠",
  "月亮不睡我不睡",
  "计算所预备役",
  "Rex",
];
const SCHOOLS = [
  "江南大学",
  "南京邮电大学",
  "杭州电子科技大学",
  "深圳大学",
  "燕山大学",
  "西南大学",
];
const FIELDS = ["CV", "NLP", "系统", "安全", "理论", "图形学"];

// A group as NapCat's get_group_member_list would return it: the first QQ owns it, the next two
// are admins, and the bot is in it too.
function fakeGroup(firstQq: number, owner?: number) {
  const members = Array.from({ length: MEMBERS }, (_, i) => ({
    user_id: i === 0 && owner ? owner : firstQq + i,
    nickname: `${NAMES[i % NAMES.length]}${i}`,
    card: `${25 + (i % 3)}-${SCHOOLS[i % SCHOOLS.length]}-${FIELDS[i % FIELDS.length]}`,
    role: i === 0 ? "owner" : i < 3 ? "admin" : "member",
    level: String(1 + ((i * 7) % 80)),
    join_time: 1_700_000_000 + i * 86_400,
    is_robot: false,
  }));
  const bot = {
    user_id: BOT_QQ,
    nickname: "鼠洞 bot",
    card: "",
    role: "member",
    level: "1",
    join_time: 1_700_000_000,
    is_robot: true,
  };
  return [...members, bot];
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function state() {
  if (!existsSync(STATE_FILE)) throw new Error("先运行 pnpm mock-bot setup");
  return StateSchema.parse(JSON.parse(readFileSync(STATE_FILE, "utf8")));
}

type Call = {
  method?: string;
  body?: unknown;
  gzip?: boolean;
  headers?: Record<string, string>;
  token?: string | null;
};

// One API call. Bot calls carry the token; `token: null` makes it a browser call.
async function call(path: string, { method = "GET", body, gzip, headers = {}, token }: Call = {}) {
  const sent = new Headers(headers);
  if (token !== null) sent.set("authorization", `Bearer ${token ?? state().token}`);
  const json = body === undefined ? undefined : JSON.stringify(body);
  if (json) sent.set("content-type", "application/json");
  if (gzip) sent.set("content-encoding", "gzip");
  const res = await fetch(`${env.PUBLIC_URL}/api/v1${path}`, {
    method,
    headers: sent,
    body: json && gzip ? gzipSync(json) : json,
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  return { status: res.status, data, cookies };
}

function show(result: { status: number; data: unknown }) {
  console.log(result.status, JSON.stringify(result.data, null, 2));
}

async function setup(owner?: number) {
  const admin = await db
    .selectFrom("users")
    .select("id")
    .where("role", "=", "admin")
    .executeTakeFirst();
  if (!admin) throw new Error("还没有管理员，先运行 pnpm bootstrap --qq <你的QQ号>");
  const actor = { userId: admin.id, operatorId: null, tokenId: null, ip: null };
  const { token } = await createBotToken(actor, {
    name: "mock-bot",
    botQq: BOT_QQ,
    scopes: [...SCOPES],
  });
  writeFileSync(STATE_FILE, JSON.stringify({ token }));
  console.log(`已创建 token，存在 ${STATE_FILE}`);

  await call("/admin/groups", { method: "POST", body: { group_id: GROUP } });
  await pushInfo(GROUP);
  show(await pushFull(GROUP, fakeGroup(910000000, owner), true));
}

function pushInfo(group: number) {
  return call(`/bot/groups/${group}/info`, {
    method: "PUT",
    body: {
      observed_at: now(),
      group_name: "鼠洞演示群",
      member_count: MEMBERS + 1,
      max_member_count: 2000,
    },
  });
}

function pushFull(group: number, members: unknown[], gzip = false, observedAt = now()) {
  return call(`/bot/groups/${group}/members`, {
    method: "PUT",
    body: { observed_at: observedAt, members },
    gzip,
  });
}

function pushDelta(group: number, members: unknown[], observedAt = now()) {
  return call(`/bot/groups/${group}/members`, {
    method: "PATCH",
    body: { observed_at: observedAt, members },
  });
}

// The whole M1 flow against a fresh group and fresh QQ numbers, so every count is known.
async function demo() {
  const results: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail: unknown) => {
    results.push([name, ok, typeof detail === "string" ? detail : JSON.stringify(detail)]);
    console.log(
      `${ok ? "✓" : "✗"} ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
    );
  };
  const run = now() % 1_000_000;
  const group = 800_000_000 + run;
  const first = 920_000_000 + run * 100;
  const members = fakeGroup(first);
  const member = first + 5;
  let t = now() - 600;

  const linked = await call("/admin/groups", { method: "POST", body: { group_id: group } });
  check("关联演示群", linked.status === 204, `群号 ${group}`);
  await pushInfo(group);

  const full = await pushFull(group, members, true, ++t);
  check("全量同步（gzip 压缩）", isCounts(full.data, { joined: MEMBERS + 1 }), full.data);

  const again = await pushFull(group, members, false, ++t);
  check(
    "同样的名单再推一次，不写数据库",
    isCounts(again.data, { unchanged: MEMBERS + 1 }),
    again.data,
  );

  const me = (qq: number) => call("/me", { headers: { "x-act-as": `qq:${qq}` } });
  const owner = await me(first);
  check("群主同步为论坛管理员", field(owner.data, "role") === "admin", owner.data);

  const left = await pushDelta(
    group,
    [{ user_id: member, in_group: false, left_reason: "leave" }],
    ++t,
  );
  const frozen = await me(member);
  check(
    "增量：退群后冻结",
    isCounts(left.data, { left: 1 }) && field(frozen.data, "member_status") === "frozen",
    frozen.data,
  );

  const late = await pushDelta(group, [{ user_id: member, in_group: true }], t - 5);
  check("乱序：更早的进群通知被忽略", isCounts(late.data, { stale: 1 }), late.data);

  await pushDelta(group, [{ user_id: member, in_group: true }], ++t);
  const back = await me(member);
  check("重新进群后恢复", field(back.data, "member_status") === "member", back.data);

  const partial = members.slice(0, MEMBERS - 10);
  const held = await pushFull(group, partial, false, ++t);
  check(
    "名单骤减：少了 11 人（含 bot），先拦下",
    isCounts(held.data, { held: true, left: 0 }),
    held.data,
  );
  const confirmed = await pushFull(group, partial, false, ++t);
  check(
    "名单骤减：下一次全量仍然这样，才标记退群",
    isCounts(confirmed.data, { held: false, left: 11 }),
    confirmed.data,
  );
  const restored = await pushFull(group, members, false, ++t);
  check("完整名单回来，全部恢复", isCounts(restored.data, { joined: 11 }), restored.data);

  // Code login: a browser asks for a code, the member sends it to the bot, the bot confirms.
  const browser = {
    origin: env.PUBLIC_URL,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0 Safari/537.36",
  };
  const code = await call("/auth/code", { method: "POST", token: null, headers: browser });
  const codeCookie = code.cookies.find((c) => c.startsWith("login_code=")) ?? "";
  const confirm = await call("/bot/auth/code/confirm", {
    method: "POST",
    body: { code: field(code.data, "code") },
    headers: { "x-act-as": `qq:${member}`, "x-operator": `qq:${member}` },
  });
  check("口令登录：bot 代成员确认，返回设备摘要", confirm.status === 200, confirm.data);
  const polled = await call("/auth/code", { token: null, headers: { cookie: codeCookie } });
  const session = polled.cookies.find((c) => c.startsWith("session=")) ?? "";
  const viaCode = await call("/me", { token: null, headers: { cookie: session } });
  check("口令登录：浏览器下一次查询就登录了", field(viaCode.data, "qq") === member, viaCode.data);

  const key = { "idempotency-key": `demo-${run}-link` };
  const asMember = { "x-act-as": `qq:${member}` };
  const link = await call("/bot/auth/links", { method: "POST", headers: { ...asMember, ...key } });
  const repeat = await call("/bot/auth/links", {
    method: "POST",
    headers: { ...asMember, ...key },
  });
  check(
    "幂等：同一个键重试，拿到同一个链接",
    field(link.data, "url") === field(repeat.data, "url"),
    "两次返回相同",
  );

  const token = new URL(String(field(link.data, "url"))).searchParams.get("token");
  const used = await call("/auth/link", {
    method: "POST",
    token: null,
    body: { token },
    headers: { origin: env.PUBLIC_URL },
  });
  check("链接登录：打开链接确认后登录", used.status === 204, `HTTP ${used.status}`);

  const sneaky = await call("/me", {
    headers: { "x-act-as": `qq:${member}`, "x-operator": `qq:${first + 10}` },
  });
  check("普通群友不能让 bot 代表别人", sneaky.status === 403, sneaky.data);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 项通过${failed ? "，有失败项" : ""}`);
  return failed === 0;
}

function field(data: unknown, name: string) {
  return Fields.safeParse(data).data?.[name];
}

function isCounts(data: unknown, expected: Record<string, unknown>) {
  return Object.entries(expected).every(([k, v]) => field(data, k) === v);
}

const USAGE = `用法：pnpm mock-bot <命令>
  setup [--owner QQ号]   创建 token，关联演示群并推送 ${MEMBERS} 个假成员（--owner 让你当群主）
  sync [--gzip]          再推一次演示群的完整名单
  join QQ号 / leave QQ号  增量：进群、退群
  link QQ号              给这位成员签发登录链接
  code 口令 QQ号          以这位成员的身份确认登录口令
  demo                   在新的群里跑一遍 M1 的完整流程，逐项检查`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { owner: { type: "string" }, gzip: { type: "boolean" } },
});
const [command, ...rest] = positionals;
const qq = (i: number) => Number(rest[i]);

switch (command) {
  case "setup":
    await setup(values.owner ? Number(values.owner) : undefined);
    break;
  case "sync":
    show(
      await pushFull(
        GROUP,
        fakeGroup(910000000, values.owner ? Number(values.owner) : undefined),
        values.gzip,
      ),
    );
    break;
  case "join":
  case "leave":
    show(
      await pushDelta(GROUP, [
        {
          user_id: qq(0),
          in_group: command === "join",
          ...(command === "leave" && { left_reason: "leave" }),
        },
      ]),
    );
    break;
  case "link":
    show(await call("/bot/auth/links", { method: "POST", headers: { "x-act-as": `qq:${qq(0)}` } }));
    break;
  case "code":
    show(
      await call("/bot/auth/code/confirm", {
        method: "POST",
        body: { code: rest[0] },
        headers: { "x-act-as": `qq:${qq(1)}` },
      }),
    );
    break;
  case "demo":
    process.exitCode = (await demo()) ? 0 : 1;
    break;
  default:
    console.log(USAGE);
}
await db.destroy();
