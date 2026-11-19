import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { countFrequent } from "./service.ts";

const api = testClient(app).api.v1;

let member = as("");
const ids: Record<string, number> = {};

// Half past the hour, Beijing time, that many days ago.
function beijing(daysAgo: number, hour = 12) {
  const today = new Date(Date.now() + 8 * 3_600_000);
  return new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - daysAgo,
      hour - 8,
      30,
    ),
  );
}

// A question whose floors, the opening one first, were posted at these times. Posted as a
// discussion, as a question costs coins, then made one.
async function questionAt(
  board: string,
  times: Date[],
  tags: string[] = [],
  kind: "question" | "discussion" = "question",
) {
  const res = await api.threads.$post(
    { json: { board, title: "夏令营要准备什么", content: { markdown: "正文" }, tags } },
    member,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id } = await res.json();
  await db.updateTable("threads").set({ kind }).where("id", "=", id).execute();
  for (let i = 1; i < times.length; i++) {
    await api.threads[":id"].posts.$post(
      { param: { id: String(id) }, json: { content: { markdown: `第 ${i} 条回复` } } },
      member,
    );
  }
  for (const [i, at] of times.entries()) {
    await db
      .updateTable("posts")
      .set({ created_at: at })
      .where("thread_id", "=", id)
      .where("floor", "=", i + 1)
      .execute();
  }
  return id;
}

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  member = as(await login((await createUser()).id));
  await api.boards.$post({ json: { slug: "faq", name: "问答" } }, admin);
  await api.boards.$post({ json: { slug: "inner", name: "内部", visibility: "members" } }, admin);
  for (const tag of [
    { name: "夏令营", kind: "topic" as const },
    { name: "预推免", kind: "topic" as const },
    { name: "南京大学", kind: "school" as const },
  ]) {
    await api.tags.$post({ json: tag }, admin);
  }

  ids.four = await questionAt(
    "faq",
    [beijing(80), beijing(20), beijing(5), beijing(1)],
    ["夏令营", "南京大学"],
  );
  ids.three = await questionAt("faq", [beijing(4), beijing(3), beijing(2)], ["夏令营", "预推免"]);
  // 23:30 and 00:30 in Beijing fall on one day in UTC.
  ids.midnight = await questionAt("faq", [beijing(30), beijing(10, 23), beijing(9, 0)]);
  ids.members = await questionAt("inner", [beijing(7), beijing(6), beijing(1)], ["夏令营"]);
  ids.twoDays = await questionAt("faq", [beijing(3), beijing(2), beijing(2, 18)]);
  ids.longAgo = await questionAt("faq", [beijing(100), beijing(3), beijing(2)]);
  ids.deleted = await questionAt("faq", [beijing(4), beijing(3), beijing(2)]);
  await db
    .updateTable("posts")
    .set({ deleted_at: new Date() })
    .where("thread_id", "=", ids.deleted)
    .where("floor", "=", 3)
    .execute();
  // A daily check-in thread, say.
  ids.discussion = await questionAt("faq", [beijing(4), beijing(3), beijing(2)], [], "discussion");

  await db
    .insertInto("thread_summaries")
    .values({ thread_id: ids.four, lead: "问的是夏令营要准备哪些材料", points: JSON.stringify([]) })
    .execute();
  await api.admin.settings.$patch({ json: { site: { summaries: true } } }, await ownerSession());
  // As the hourly job does.
  await countFrequent();
}, 60_000);

async function frequent(query: { tag?: string }, who?: typeof member) {
  const res = await api.threads.frequent.$get({ query }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("高频问题", () => {
  test("问答帖按北京时间数近 90 天有新楼层的天数，至少 3 天，天数多的在前，一样多的最近有讨论的在前", async () => {
    const page = await frequent({}, member);
    expect(page.items.map((i) => [i.thread.id, i.days])).toEqual([
      [ids.four, 4],
      [ids.members, 3],
      [ids.three, 3],
      [ids.midnight, 3],
    ]);
    expect(page.next_cursor).toBeNull();
  });

  test("只列看的人能打开的，话题标签按其中的帖子数排，院校和方向不列", async () => {
    const guest = await frequent({});
    expect(guest.items.map((i) => i.thread.id)).toEqual([ids.four, ids.three, ids.midnight]);
    expect(guest.topics).toEqual([
      { name: "夏令营", count: 2 },
      { name: "预推免", count: 1 },
    ]);
    expect((await frequent({}, member)).topics).toEqual([
      { name: "夏令营", count: 3 },
      { name: "预推免", count: 1 },
    ]);
    const tagged = await frequent({ tag: "预推免" });
    expect(tagged.items.map((i) => i.thread.id)).toEqual([ids.three]);
  });

  test("带 AI 总结的第一句", async () => {
    const page = await frequent({}, member);
    expect(page.items.map((i) => i.lead)).toEqual(["问的是夏令营要准备哪些材料", null, null, null]);
  });
});
