import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";

const api = testClient(app).api.v1;

let member = as("");
const guest = { headers: {} };

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "s", name: "搜索" } }, admin);
  await api.boards.$post({ json: { slug: "in", name: "仅成员", visibility: "members" } }, admin);
  member = as(await login((await createUser()).id));
});

async function thread(title: string, markdown: string, board = "s") {
  const res = await api.threads.$post({ json: { board, title, content: { markdown } } }, member);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function reply(threadId: number, markdown: string) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown } } },
    member,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function find(q: string, who: { headers: Record<string, string> } = member) {
  const res = await api.search.$get({ query: { q } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

async function titles(q: string, who?: { headers: Record<string, string> }) {
  return (await find(q, who)).map((r) => r.thread.title);
}

describe("搜索", () => {
  test("中文按相邻的两个字匹配，多个词都要有；英文不分大小写；命中回复时带那一层和片段", async () => {
    const ecnu = await thread("华东师范大学夏令营经验", "流程和材料");
    await reply(ecnu, "我去年 Rank 30% 也进了");

    expect(await titles("华东师范")).toEqual(["华东师范大学夏令营经验"]);
    expect(await titles("东华")).toEqual([]);
    expect(await titles("师大")).toEqual([]);
    expect(await titles("华东 夏令营")).toEqual(["华东师范大学夏令营经验"]);
    expect(await titles("华东 预推免")).toEqual([]);

    const [hit] = await find("rank 30");
    expect(hit).toMatchObject({ post: { floor: 2 }, snippet: "我去年 Rank 30% 也进了" });
  });

  test("标题里有的排在只有正文里有的前面；一个汉字只搜标题", async () => {
    await thread("机试经验分享", "刷题");
    await thread("随便聊聊", "最近在准备机试");
    expect(await titles("机试")).toEqual(["机试经验分享", "随便聊聊"]);
    expect(await titles("聊")).toEqual(["随便聊聊"]);
  });

  test("删掉的回复搜不到；仅成员版块的只有成员搜得到；改过的内容按新的搜", async () => {
    const id = await thread("关于导师选择", "先看组里的论文");
    const removed = await reply(id, "套磁信模板");
    await api.posts[":id"].$delete({ param: { id: String(removed) } }, member);
    expect(await titles("套磁信")).toEqual([]);

    await thread("内部讨论贴", "只给群友看的经验", "in");
    expect(await titles("内部讨论")).toEqual(["内部讨论贴"]);
    expect(await titles("内部讨论", guest)).toEqual([]);

    await api.threads[":id"].$patch(
      { param: { id: String(id) }, json: { title: "导师选择和套磁" } },
      member,
    );
    expect(await titles("套磁")).toEqual(["导师选择和套磁"]);
  });

  test("相似问题：用提问原文找到最像的主题", async () => {
    const id = await thread("南京大学软件学院预推免面试问什么", "面试流程");
    const res = await api.search.similar.$get({
      query: { text: "请问南大软院的预推免面试一般问些什么？" },
    });
    const [best] = (await res.json()).items;
    expect(best.thread.id).toBe(id);
    expect(best.score).toBeGreaterThan(0);
    expect(best.score).toBeLessThan(1);
  });
});
