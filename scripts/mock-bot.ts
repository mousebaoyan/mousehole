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
import { DEMO_THREADS } from "./demo-content.ts";

const STATE_FILE = ".mock-bot.json";
const GROUP = 100200300;
const BOT_QQ = 900000000;
// The demo group's members have QQ numbers from here on.
const FIRST_QQ = 910000000;
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

// The boards and tags the style draft showed, for local development.
const DEMO_BOARDS = [
  {
    slug: "announce",
    name: "公告",
    color: "#55625f",
    description: "站务公告与规则",
    post_role: "moderator",
  },
  {
    slug: "qa",
    name: "保研问答",
    color: "#e07b53",
    description: "定位、材料、流程等问题",
    default_kind: "question",
  },
  {
    slug: "experience",
    name: "经验分享",
    color: "#5e9a6f",
    description: "夏令营、预推免与上岸复盘",
  },
  {
    slug: "deadlines",
    name: "通知与截止日期",
    color: "#d29b2f",
    description: "各院校通知与报名截止时间",
  },
  { slug: "schools", name: "院校交流", color: "#5a7fa6", description: "院校、导师与方向的选择" },
  { slug: "chat", name: "闲聊", color: "#ad7a9f", description: "保研之外的日常" },
];

const DEMO_TAGS = {
  topic: [
    "夏令营",
    "预推免",
    "九推",
    "简历",
    "机试",
    "面试",
    "导师",
    "定位",
    "科研",
    "经验",
    "必读",
  ],
  school: ["南京大学", "复旦大学", "上海交通大学", "浙江大学", "中科院计算所"],
  major: ["系统", "CV", "NLP", "安全"],
};

// A group as NapCat's get_group_member_list would return it: the first QQ owns it, the next two
// are admins, and the bot is in it too.
function fakeGroup(firstQq: number, owner?: number) {
  const members = Array.from({ length: MEMBERS }, (_, i) => ({
    user_id: i === 0 && owner ? owner : firstQq + i,
    nickname: `${NAMES[i % NAMES.length]}${i}`,
    card: `${25 + (i % 3)}-${SCHOOLS[i % SCHOOLS.length]}-${FIELDS[i % FIELDS.length]}`,
    role: i === 0 ? "owner" : i < 3 ? "admin" : "member",
    join_time: 1_700_000_000 + i * 86_400,
    is_robot: false,
  }));
  const bot = {
    user_id: BOT_QQ,
    nickname: "鼠洞 bot",
    card: "",
    role: "member",
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

// Prints the event stream as the plugin would receive it, until stopped.
async function listen() {
  const res = await fetch(`${env.PUBLIC_URL}/api/v1/bot/events`, {
    headers: { authorization: `Bearer ${state().token}` },
  });
  if (!res.body) throw new Error(`事件流连不上：HTTP ${res.status}`);
  console.log("在听事件流，Ctrl-C 停止");
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    process.stdout.write(chunk);
  }
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
  const actor = { userId: admin.id, operatorId: null, tokenId: null, ip: null, userAgent: null };
  const { token } = await createBotToken(actor, {
    name: "mock-bot",
    botQq: BOT_QQ,
    scopes: [...SCOPES],
  });
  writeFileSync(STATE_FILE, JSON.stringify({ token }));
  console.log(`已创建 token，存在 ${STATE_FILE}`);

  await call("/admin/groups", { method: "POST", body: { group_id: GROUP } });
  await pushInfo(GROUP);
  show(await pushFull(GROUP, fakeGroup(FIRST_QQ, owner), true));
}

// Acting as a member of the demo group by index.
function asDemoMember(index: number) {
  return { "x-act-as": `qq:${FIRST_QQ + index}` };
}

// True when created, false when it already existed.
function isCreated(what: string, res: { status: number; data: unknown }) {
  if (res.status === 201) return true;
  if (res.status === 409) return false;
  throw new Error(`${what}：${res.status} ${JSON.stringify(res.data)}`);
}

// Creates what is missing and leaves the rest alone, so it can run again.
async function seed() {
  const created = { boards: 0, tags: 0 };
  for (const board of DEMO_BOARDS) {
    if (isCreated(board.name, await call("/boards", { method: "POST", body: board }))) {
      created.boards++;
    }
  }
  for (const [kind, names] of Object.entries(DEMO_TAGS)) {
    for (const name of names) {
      if (isCreated(name, await call("/tags", { method: "POST", body: { name, kind } }))) {
        created.tags++;
      }
    }
  }
  console.log(`新建 ${created.boards} 个版块、${created.tags} 个标签，已有的跳过`);

  const existing = await call(`/threads?board=${DEMO_THREADS[0].board}`);
  if (Fields.array().parse(field(existing.data, "items")).length > 0) {
    console.log("已经有帖子了，不再发演示帖子");
    return;
  }
  // Demo members at different levels, so pages show them and posting isn't held to L0's limits.
  const writers = new Set(DEMO_THREADS.flatMap((t) => [t.by, ...t.replies.map((r) => r.by)]));
  for (const by of writers) {
    await call(`/users/qq:${FIRST_QQ + by}/level`, {
      method: "PUT",
      body: { level: 1 + (by % 4), locked: false },
    });
  }
  for (const thread of DEMO_THREADS) {
    const { replies, by, body, ...fields } = thread;
    const posted = await call("/threads", {
      method: "POST",
      headers: asDemoMember(by),
      body: { ...fields, content: { markdown: body } },
    });
    if (posted.status !== 201) throw new Error(`${thread.title}：${JSON.stringify(posted.data)}`);
    const id = Number(field(posted.data, "id"));
    // Post IDs by floor, for replies that answer an earlier floor.
    const floors = Fields.array().parse(field((await call(`/threads/${id}/posts`)).data, "items"));
    const ids = new Map(floors.map((p) => [p.floor, p.id]));
    for (const reply of replies) {
      const res = await call(`/threads/${id}/posts`, {
        method: "POST",
        headers: asDemoMember(reply.by),
        body: {
          content: { markdown: reply.body },
          reply_to_id: reply.to === undefined ? undefined : ids.get(reply.to),
        },
      });
      ids.set(Number(field(res.data, "floor")), field(res.data, "id"));
    }
  }
  console.log(`发了 ${DEMO_THREADS.length} 个演示帖子`);
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

// The whole flow so far against a fresh group and fresh QQ numbers, so every count is known.
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

  const since = Number(field((await call("/bot/events/batch")).data, "next_after"));
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

  // What the plugin does on member.activated: looks up the QQ signature and pushes it.
  const signature = "鼠鼠的 QQ 签名";
  const bio = await call(`/bot/users/qq:${member}/bio`, {
    method: "PUT",
    body: { bio: signature },
  });
  const card = await call(`/users/qq:${member}`);
  check(
    "激活后推送 QQ 个性签名，资料卡上显示",
    bio.status === 204 && field(card.data, "bio") === signature,
    card.data,
  );

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

  // One board for every run: boards that ever had threads can't be deleted.
  const slug = "demo";
  const board = await call("/boards", {
    method: "POST",
    body: { slug, name: "演示（仅成员）", visibility: "members" },
  });
  check(
    "bot 用 admin 范围新建仅成员版块（已有就用现成的）",
    board.status === 201 || board.status === 409,
    `HTTP ${board.status}`,
  );
  const asGuest = await call(`/boards/${slug}`, { token: null });
  const asBot = await call(`/boards/${slug}`);
  check(
    "访客看不到仅成员版块，有 read 范围的 bot 看得到",
    asGuest.status === 404 && asBot.status === 200,
    `访客 ${asGuest.status}，bot ${asBot.status}`,
  );

  // A member's message turned into a thread; a retry with the same key must not post twice.
  const post = {
    method: "POST",
    headers: { ...asMember, "idempotency-key": `demo-${run}-thread` },
    body: { board: slug, title: "群里转来的问题", content: { markdown: "夏令营**几号**截止？" } },
  };
  const thread = await call("/threads", post);
  const retried = await call("/threads", post);
  const threadId = Number(field(thread.data, "id"));
  check(
    "代成员发帖，同一个幂等键重试不会重复发",
    thread.status === 201 && field(retried.data, "id") === threadId,
    `帖子 ${threadId}`,
  );
  const floors = await call(`/threads/${threadId}/posts`);
  const opening = Fields.array().parse(field(floors.data, "items")).at(0);
  const replied = await call(`/threads/${threadId}/posts`, {
    method: "POST",
    headers: asMember,
    body: { content: { markdown: "6 月 10 日" }, reply_to_id: opening?.id },
  });
  check(
    "回复主楼：排在 2 楼，记下回复的是 1 楼",
    field(replied.data, "floor") === 2 &&
      Fields.safeParse(field(replied.data, "reply_to")).data?.floor === 1,
    replied.data,
  );
  // A question asked in the group, turned into a thread; the bot announces it, and a member
  // answers by quoting the question.
  const question = { chat_type: "group", chat_id: group, message_id: run * 10 + 1 };
  const fromGroup = await call("/threads", {
    method: "POST",
    headers: asMember,
    body: {
      board: slug,
      title: "群里的提问：夏令营要准备什么",
      content: {
        onebot: [
          { type: "text", data: { text: "夏令营要准备**哪些材料**？" } },
          { type: "image", data: { url: "https://gchat.qpic.cn/expired" } },
        ],
      },
      source: question,
    },
  });
  const fromGroupId = Number(field(fromGroup.data, "id"));
  const twice = await call("/threads", {
    method: "POST",
    headers: asMember,
    body: {
      board: slug,
      title: "群里的提问：再转一次",
      content: { markdown: "x" },
      source: question,
    },
  });
  check(
    "群消息转成帖子；同一条消息再转返回已有的帖子",
    fromGroup.status === 201 &&
      twice.status === 409 &&
      field(twice.data, "thread_id") === fromGroupId,
    `帖子 ${fromGroupId}，再转 HTTP ${twice.status}`,
  );
  const noticeAt = `/bot/messages/group/${group}/${run * 10 + 2}`;
  const notice = await call(noticeAt, { method: "PUT", body: { thread_id: fromGroupId } });
  const lookedUp = await call(noticeAt);
  check(
    "记下转存回执，再按消息查得到帖子",
    notice.status === 204 && field(lookedUp.data, "thread_id") === fromGroupId,
    lookedUp.data,
  );
  const answer = await call(`/threads/${fromGroupId}/posts`, {
    method: "POST",
    headers: asMember,
    body: {
      content: {
        onebot: [
          { type: "reply", data: { id: String(question.message_id) } },
          { type: "text", data: { text: "成绩单和推荐信" } },
        ],
      },
      source: { ...question, message_id: run * 10 + 3 },
    },
  });
  check(
    "引用提问回答：记为回复主楼，标为来自群聊",
    Fields.safeParse(field(answer.data, "reply_to")).data?.floor === 1 &&
      field(answer.data, "via") === "qq",
    answer.data,
  );

  // What the plugin hears: the question with the message it came from, and the answer with the
  // message it answers, which the plugin can quote back in the group.
  const heard = await call(
    `/bot/events/batch?after=${since}&types=thread.created,post.created&limit=500`,
  );
  const events = Fields.array().parse(field(heard.data, "items"));
  const about = (type: string) =>
    events.findLast((e) => e.type === type && field(field(e.data, "thread"), "id") === fromGroupId);
  const same = (source: unknown) =>
    Object.entries(question).every(([k, v]) => field(source, k) === v);
  check(
    "事件流：群里的提问带来源消息，回答带被回复那条的来源",
    same(field(about("thread.created")?.data, "source")) &&
      same(field(field(about("post.created")?.data, "reply_to"), "source")),
    `${events.length} 个事件`,
  );

  // The plugin reviewing: while the board is reviewed before publishing, the member's thread
  // waits until the bot, having heard of it, lets it through; a reply it finds to be an ad is
  // hidden with the reason.
  await call(`/boards/${slug}`, { method: "PATCH", body: { review_mode: "before" } });
  const pending = await call("/threads", {
    method: "POST",
    headers: asMember,
    body: { board: slug, title: "先审后发的帖子", content: { markdown: "等 bot 审核" } },
  });
  await call(`/boards/${slug}`, { method: "PATCH", body: { review_mode: "after" } });
  const pendingId = Number(field(pending.data, "id"));
  const approved = await call(`/threads/${pendingId}`, {
    method: "PATCH",
    body: { status: "visible" },
  });
  const replyId = Number(field(replied.data, "id"));
  const ad = await call(`/posts/${replyId}`, {
    method: "PATCH",
    body: { status: "hidden", reason: "广告" },
  });
  const reviewed = Fields.array().parse(
    field(
      (
        await call(
          `/bot/events/batch?after=${since}&types=content.pending,thread.created,post.deleted&limit=500`,
        )
      ).data,
      "items",
    ),
  );
  const told = (type: string, data: (d: unknown) => boolean) =>
    reviewed.some((e) => e.type === type && data(e.data));
  const ofPending = (d: unknown) => field(field(d, "thread"), "id") === pendingId;
  check(
    "先审后发：帖子等待审核，bot 收到 content.pending 后通过，这时才有 thread.created",
    field(pending.data, "status") === "pending" &&
      field(approved.data, "status") === "visible" &&
      told("content.pending", ofPending) &&
      told("thread.created", ofPending),
    `帖子 ${pendingId}`,
  );
  check(
    "bot 隐藏一层回复，事件流收到带理由的 post.deleted",
    ad.status === 200 &&
      told("post.deleted", (d) => field(d, "post_id") === replyId && field(d, "reason") === "广告"),
    `HTTP ${ad.status}`,
  );

  const hidden = await call(`/threads/${threadId}`, { token: null });
  check("访客打不开仅成员版块里的帖子", hidden.status === 404, `HTTP ${hidden.status}`);
  const removed = await call(`/boards/${slug}`, { method: "DELETE" });
  check("有过帖子的版块不能删", removed.status === 409, removed.data);

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
  seed                   建演示用的版块、标签和帖子，已有的跳过
  sync [--gzip]          再推一次演示群的完整名单
  join QQ号 / leave QQ号  增量：进群、退群
  link QQ号              给这位成员签发登录链接
  code 口令 QQ号          以这位成员的身份确认登录口令
  demo                   在新的群里跑一遍 bot 的完整流程，逐项检查
  events                 接上事件流，把收到的事件原样打出来`;

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
  case "seed":
    await seed();
    break;
  case "sync":
    show(
      await pushFull(
        GROUP,
        fakeGroup(FIRST_QQ, values.owner ? Number(values.owner) : undefined),
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
  case "events":
    await listen();
    break;
  default:
    console.log(USAGE);
}
await db.destroy();
