import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let shy = as("");
let shyId = 0;
let other = as("");
const ids = { own: 0, theirs: 0, reply: 0 };

async function hideFromGuests(on: boolean) {
  const res = await api.me.$patch({ json: { hide_from_guests: on } }, shy);
  if (!res.ok) throw new Error(`status ${res.status}`);
}

async function post(who: Who, title: string) {
  const res = await api.threads.$post(
    { json: { board: "guests", title, content: { markdown: `${title}的正文` } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function listed(who?: Who) {
  const res = await api.threads.$get({ query: { board: "guests" } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((t) => t.id);
}

async function floors(who?: Who) {
  const res = await api.threads[":id"].posts.$get(
    { param: { id: String(ids.theirs) }, query: {} },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "guests", name: "访客测试" } }, admin);
  shyId = (await createUser()).id;
  shy = as(await login(shyId));
  other = as(await login((await createUser()).id));
  ids.own = await post(shy, "不给访客看的帖子");
  ids.theirs = await post(other, "别人的帖子");
  const reply = await api.threads[":id"].posts.$post(
    { param: { id: String(ids.theirs) }, json: { content: { markdown: "藏起来的回复" } } },
    shy,
  );
  if (!reply.ok) throw new Error(`status ${reply.status}`);
  ids.reply = (await reply.json()).id;
  await api.posts[":id"].reaction.$put(
    { param: { id: String(ids.reply) }, json: { emoji: "heart" } },
    other,
  );
  await api.posts[":id"].boost.$put(
    { param: { id: String(ids.reply) }, json: { body: "好" } },
    other,
  );
  const opening = (await floors(other))[0];
  await api.posts[":id"].boost.$put(
    { param: { id: String(opening.id) }, json: { body: "藏起来的短评" } },
    shy,
  );
  await hideFromGuests(true);
});

describe("我的内容不给访客看", () => {
  test("访客的列表、搜索和 sitemap 里没有这个人的帖子，打开链接要先登录；成员照常", async () => {
    expect(await listed()).not.toContain(ids.own);
    expect(await listed(other)).toContain(ids.own);

    const opened = await api.threads[":id"].$get({ param: { id: String(ids.own) } });
    expect(opened.status).toBe(401);
    expect(await opened.json()).toMatchObject({ error: { code: "login_required" } });
    expect((await api.threads[":id"].$get({ param: { id: String(ids.own) } }, other)).status).toBe(
      200,
    );

    const found = async (who?: Who) => {
      const res = await api.search.$get({ query: { q: "藏起来" } }, who);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items.length;
    };
    expect(await found()).toBe(0);
    expect(await found(other)).toBe(1);

    const xml = await (await app.request("/sitemap.xml")).text();
    expect(xml).not.toContain(`/t/${ids.own}<`);
    expect(xml).toContain(`/t/${ids.theirs}<`);
  });

  test("别人帖子里这个人的楼层，访客只看到楼层号；短评不显示", async () => {
    const [opening, reply] = await floors();
    expect(reply).toMatchObject({
      floor: 2,
      members_only: true,
      html: "",
      like_count: 0,
      reactions: {},
      boosts: [],
    });
    expect(opening.boosts.map((b) => b.body)).not.toContain("藏起来的短评");

    const [, seen] = await floors(other);
    expect(seen).toMatchObject({ members_only: false, like_count: 1 });
    expect(seen.html).toContain("藏起来的回复");
  });

  test("访客看个人主页只有名字和头像；关掉开关后恢复公开", async () => {
    const profile = async (who?: Who) => {
      const res = await api.users[":user"].$get({ param: { user: String(shyId) } }, who);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    };
    expect(await profile()).toEqual({
      id: shyId,
      display_name: "鼠鼠",
      avatar_url: null,
      role: "user",
      title: "",
      members_only: true,
    });
    expect(await profile(other)).toMatchObject({ members_only: false });

    await hideFromGuests(false);
    expect(await listed()).toContain(ids.own);
    expect(await profile()).toMatchObject({ members_only: false });
    await hideFromGuests(true);
  });
});
