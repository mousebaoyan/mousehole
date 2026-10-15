import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { letterHtml } from "./letter.ts";
import { lastWeek, sendWeeklyLetters } from "./service.ts";

const api = testClient(app).api.v1;

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

// Next Monday 09:30, Beijing time: the letters then cover the week that is going on now.
const { end } = lastWeek(new Date(Date.now() + 7 * DAY_MS));
const sendAt = new Date(end.getTime() + 9.5 * HOUR_MS);

let owner = { headers: {} };
let admin = { headers: {} };
let threadId = 0;

beforeAll(async () => {
  owner = await ownerSession();
  admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "weekly", name: "每周" } }, admin);
  const res = await api.threads.$post(
    { json: { board: "weekly", title: "夏令营经验", content: { markdown: "主楼" } } },
    admin,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  threadId = (await res.json()).id;
});

// Someone with a reply in the thread, read and liked this week as told.
async function member(week: { reads: number; likes: number; accepted?: boolean }) {
  const { id, qq } = await createUser();
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown: "我的经验" } } },
    as(await login(id)),
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id: postId } = await res.json();
  await db
    .insertInto("user_reads")
    .values({
      user_id: id,
      day: sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date`,
      reads: week.reads,
    })
    .execute();
  for (let i = 0; i < week.likes; i++) {
    const liker = await createUser();
    await db
      .insertInto("reactions")
      .values({ post_id: postId, user_id: liker.id, emoji: "heart" })
      .execute();
  }
  if (week.accepted) {
    await db
      .updateTable("posts")
      .set({ accepted_at: new Date() })
      .where("id", "=", postId)
      .execute();
  }
  return { id, qq };
}

async function lettersTo(qq: number) {
  return db
    .selectFrom("mail_queue")
    .select(["subject", "body", "html"])
    .where("address", "=", `${qq}@qq.com`)
    .execute();
}

async function sendAgain(now = sendAt) {
  await db.deleteFrom("job_runs").where("name", "=", "weekly_letters").execute();
  await sendWeeklyLetters(now);
}

describe("每周来信", () => {
  test("上一周是北京时间周一零点到下周一零点", () => {
    const week = lastWeek(new Date("2026-10-19T09:30:00+08:00"));
    expect(week).toEqual({
      start: new Date("2026-10-12T00:00:00+08:00"),
      end: new Date("2026-10-19T00:00:00+08:00"),
    });
    expect(lastWeek(new Date("2026-10-18T23:59:00+08:00")).end).toEqual(
      new Date("2026-10-12T00:00:00+08:00"),
    );
  });

  test("被读和获赞都够、或有回答被采纳的才收到；为零的项不写，获赞够多的楼层写进信里", async () => {
    const enough = await member({ reads: 25, likes: 5 });
    const fewLikes = await member({ reads: 25, likes: 2 });
    const answered = await member({ reads: 0, likes: 0, accepted: true });
    const optedOut = await member({ reads: 30, likes: 6 });
    await api.me.$patch({ json: { weekly_email: false } }, as(await login(optedOut.id)));

    await sendAgain();
    const [letter] = await lettersTo(enough.qq);
    expect(letter.subject).toContain("被读了 25 次");
    expect(letter.body).toContain("被读 25 次，获赞 5 次");
    expect(letter.body).not.toContain("被采纳");
    expect(letter.body).toContain(`夏令营经验 #`);
    expect(letter.html).toContain("每周来信");
    expect(await lettersTo(fewLikes.qq)).toEqual([]);
    expect(await lettersTo(optedOut.qq)).toEqual([]);
    const [answer] = await lettersTo(answered.qq);
    expect(answer.subject).toContain("被采纳了 1 次");
    expect(answer.body).not.toContain("被读");
  });

  test("周一 9 点以前不发，一周只发一次；站长关掉或调高门槛后照办", async () => {
    const person = await member({ reads: 40, likes: 4 });
    await sendAgain(new Date(end.getTime() + 8 * HOUR_MS));
    expect(await lettersTo(person.qq)).toEqual([]);
    await sendAgain();
    await sendWeeklyLetters(new Date(sendAt.getTime() + HOUR_MS));
    expect(await lettersTo(person.qq)).toHaveLength(1);

    await db.deleteFrom("mail_queue").execute();
    await api.admin.settings.$patch({ json: { weekly: { min_likes: 10 } } }, owner);
    await sendAgain();
    expect(await lettersTo(person.qq)).toEqual([]);
    await api.admin.settings.$patch({ json: { weekly: { min_likes: 3, enabled: false } } }, owner);
    await sendAgain();
    expect(await lettersTo(person.qq)).toEqual([]);
    await api.admin.settings.$patch({ json: { weekly: { enabled: true } } }, owner);
  });

  test("信里的名字和标题都转义", async () => {
    const html = await letterHtml({
      name: "<b>鼠鼠</b>",
      activated: false,
      reads: 1,
      likes: 0,
      accepted: 0,
      badges: [],
      top: [{ title: "<script>", floor: 2, likes: 5, url: "https://example.com/t/1?floor=2" }],
      peopleReached: 1,
      profileUrl: "https://example.com/u/1",
      settingsUrl: "https://example.com/settings",
    });
    expect(html).not.toContain("<b>鼠鼠");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;鼠鼠");
    expect(html).not.toContain("获赞（次）");
  });
});
