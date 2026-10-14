import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let moderator: Who = as("");
let author: Who = as("");
let reporter: Who = as("");
let post = 0;

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  moderator = as(await login((await createUser("moderator")).id));
  author = as(await login((await createUser()).id));
  reporter = as(await login((await createUser()).id));
  await api.boards.$post({ json: { slug: "r", name: "举报" } }, admin);
  const res = await api.threads.$post(
    { json: { board: "r", title: "有问题的帖子", content: { markdown: "广告：代写简历" } } },
    author,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const posts = await api.threads[":id"].posts.$get({
    param: { id: String((await res.json()).id) },
    query: {},
  });
  if (!posts.ok) throw new Error(`status ${posts.status}`);
  post = (await posts.json()).items[0].id;
});

async function reports(status: "open" | "resolved") {
  const res = await api.admin.reports.$get({ query: { status } }, moderator);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

describe("举报", () => {
  test("每人对每层举报一次，插件收到事件；版主处理后从待处理挪到已处理", async () => {
    const param = { id: String(post) };
    const json = { reason: "垃圾广告" };
    expect((await api.posts[":id"].report.$post({ param, json }, reporter)).status).toBe(204);
    const again = await api.posts[":id"].report.$post({ param, json }, reporter);
    expect(again.status).toBe(409);

    const event = await db
      .selectFrom("events")
      .select("data")
      .where("type", "=", "report.created")
      .executeTakeFirstOrThrow();
    expect(event.data).toMatchObject({
      report: { reason: "垃圾广告" },
      post: { id: post },
      boost: null,
    });

    const [open] = await reports("open");
    expect(open).toMatchObject({
      reason: "垃圾广告",
      post: { id: post, excerpt: "广告：代写简历" },
    });
    await api.admin.reports[":id"].$patch(
      { param: { id: String(open.id) }, json: { status: "resolved" } },
      moderator,
    );
    expect(await reports("open")).toEqual([]);
    expect((await reports("resolved"))[0]).toMatchObject({
      id: open.id,
      handler: { role: "moderator" },
    });
  });

  test("举报短评；短评删掉后举报也没了", async () => {
    const boost = await api.posts[":id"].boost.$put(
      { param: { id: String(post) }, json: { body: "加微信" } },
      author,
    );
    if (!boost.ok) throw new Error(`status ${boost.status}`);
    const { id } = await boost.json();
    await api.boosts[":id"].report.$post(
      { param: { id: String(id) }, json: { reason: "垃圾广告" } },
      reporter,
    );
    expect((await reports("open"))[0]).toMatchObject({ boost: { id, body: "加微信" } });

    await api.boosts[":id"].$delete({ param: { id: String(id) }, json: {} }, moderator);
    expect(await reports("open")).toEqual([]);
  });

  test("要登录；普通成员看不到举报列表", async () => {
    const param = { id: String(post) };
    expect((await api.posts[":id"].report.$post({ param, json: { reason: "x" } })).status).toBe(
      401,
    );
    expect((await api.admin.reports.$get({ query: {} }, reporter)).status).toBe(403);
  });
});
