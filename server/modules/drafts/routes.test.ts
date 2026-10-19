import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { clearOldDrafts } from "./service.ts";

const api = testClient(app).api.v1;

let me = as("");
let myId = 0;

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "d", name: "草稿" } }, admin);
  myId = (await createUser()).id;
  me = as(await login(myId));
});

async function draft(key: string) {
  const res = await api.me.drafts[":key"].$get({ param: { key } }, me);
  return res.ok ? res.json() : res.status;
}

async function save(
  key: string,
  json: Parameters<(typeof api.me.drafts)[":key"]["$put"]>[0]["json"],
) {
  const res = await api.me.drafts[":key"].$put({ param: { key }, json }, me);
  expect(res.status).toBe(204);
}

async function newThread(title: string) {
  const res = await api.threads.$post(
    { json: { board: "d", title, content: { markdown: "正文" } } },
    me,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

describe("草稿", () => {
  test("发帖的草稿整份保存、再存就替换；发出去后草稿删掉", async () => {
    await save("new", {
      title: "写了一半",
      board: "d",
      kind: "positioning",
      positioning: { fields: { rank: "" }, schools: [] },
      tags: ["夏令营"],
      body: "第一版",
    });
    await save("new", {
      title: "写了一半",
      board: "d",
      kind: "positioning",
      positioning: { fields: { rank: "前 10%" }, schools: ["南京大学"] },
      tags: [],
      body: "第二版",
    });
    expect(await draft("new")).toMatchObject({
      thread_id: null,
      title: "写了一半",
      board: "d",
      kind: "positioning",
      positioning: { fields: { rank: "前 10%" }, schools: ["南京大学"] },
      tags: [],
      body: "第二版",
      reply_to: null,
    });

    await newThread("写了一半的帖子");
    expect(await draft("new")).toBe(404);
  });

  test("回复的草稿每个帖子一份，记着回复哪一层；别的帖子里的楼层不记", async () => {
    const thread = await newThread("等人回复的帖子");
    const other = await newThread("另一个帖子");
    const posts = await api.threads[":id"].posts.$get(
      { param: { id: String(thread) }, query: {} },
      me,
    );
    if (!posts.ok) throw new Error(`status ${posts.status}`);
    const [opening] = (await posts.json()).items;

    await save(String(thread), { body: "回复写了一半", reply_to_id: opening.id });
    await save(String(other), { body: "回错地方", reply_to_id: opening.id });
    expect(await draft(String(thread))).toMatchObject({
      thread_id: thread,
      body: "回复写了一半",
      reply_to: { id: opening.id, floor: 1, name: "鼠鼠" },
    });
    expect(await draft(String(other))).toMatchObject({ reply_to: null });

    const list = await api.me.drafts.$get({}, me);
    if (!list.ok) throw new Error(`status ${list.status}`);
    expect((await list.json()).items.map((d) => d.thread?.title)).toEqual([
      "另一个帖子",
      "等人回复的帖子",
    ]);

    await api.threads[":id"].posts.$post(
      { param: { id: String(thread) }, json: { content: { markdown: "回复写完了" } } },
      me,
    );
    expect(await draft(String(thread))).toBe(404);
    const removed = await api.me.drafts[":key"].$delete({ param: { key: String(other) } }, me);
    expect(removed.status).toBe(204);
    expect(await draft(String(other))).toBe(404);
  });

  test("不存在的帖子不能存回复草稿；180 天没动过的草稿每天清掉", async () => {
    const missing = await api.me.drafts[":key"].$put(
      { param: { key: "999999" }, json: { body: "没有这个帖子" } },
      me,
    );
    expect(missing.status).toBe(404);

    await save("new", { body: "很久以前" });
    await db
      .updateTable("drafts")
      .set({ updated_at: new Date(Date.now() - 181 * 86_400_000) })
      .where("user_id", "=", myId)
      .execute();
    await clearOldDrafts();
    expect(await draft("new")).toBe(404);
  });
});
