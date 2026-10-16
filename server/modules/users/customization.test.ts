import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin = as("");

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "looks", name: "个性化" } }, admin);
  await api.boards.$post(
    { json: { slug: "looks-inner", name: "内部", visibility: "members" } },
    admin,
  );
});

async function person() {
  const { id } = await createUser();
  return { id, who: as(await login(id)) };
}

async function thread(who: Who, board = "looks", anonymous = false) {
  const res = await api.threads.$post(
    { json: { board, title: "我的经验贴", content: { markdown: "正文" }, anonymous } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function card(userId: number) {
  const res = await api.users[":user"].$get({ param: { user: String(userId) } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const user = await res.json();
  if (user.members_only) throw new Error("members only");
  return user;
}

async function showcase(userId: number, who?: Who) {
  const res = await api.users[":user"].showcase.$get({ param: { user: String(userId) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("个性化", () => {
  test("状态到点就不再显示，楼层里的作者也一样；表情只能是一个", async () => {
    const member = await person();
    const set = (user_status: { emoji: string; text: string; until: number | null } | null) =>
      api.me.$patch({ json: { user_status } }, member.who);
    expect((await set({ emoji: "🎉", text: "已上岸", until: null })).status).toBe(200);
    expect((await card(member.id)).user_status).toEqual({ emoji: "🎉", text: "已上岸" });

    const threadId = await thread(member.who);
    await db
      .updateTable("users")
      .set({ status_until: new Date(Date.now() - 1000) })
      .where("id", "=", member.id)
      .execute();
    expect((await card(member.id)).user_status).toBeNull();
    const floors = await api.threads[":id"].posts.$get({
      param: { id: String(threadId) },
      query: {},
    });
    if (!floors.ok) throw new Error(`status ${floors.status}`);
    expect((await floors.json()).items[0].author).toMatchObject({ user_status: null });

    expect((await set({ emoji: "🎉🎉", text: "两个", until: null })).status).toBe(400);
    expect((await set({ emoji: "a", text: "不是表情", until: null })).status).toBe(400);
    expect((await set({ emoji: "🎉", text: "字".repeat(31), until: null })).status).toBe(400);
  });

  test("代表作只能选自己公开发布的帖子，按选的顺序；看的人打不开的、后来隐藏的不显示", async () => {
    const member = await person();
    const other = await person();
    const [open, inner, later] = [
      await thread(member.who),
      await thread(member.who, "looks-inner"),
      await thread(member.who),
    ];
    const pin = (pins: number[]) => api.me.$patch({ json: { pins } }, member.who);

    for (const wrong of [
      [await thread(other.who)],
      [await thread(member.who, "looks", true)],
      [open, open],
    ]) {
      expect((await pin(wrong)).status).toBe(400);
    }
    expect((await pin([later, inner, open])).status).toBe(200);
    const ids = async (who?: Who) => (await showcase(member.id, who)).pins.map((t) => t.id);
    expect(await ids(other.who)).toEqual([later, inner, open]);
    expect(await ids()).toEqual([later, open]);

    await db.updateTable("threads").set({ status: "hidden" }).where("id", "=", later).execute();
    expect(await ids(other.who)).toEqual([inner, open]);
  });

  test("展柜里的图片显示成链接；不给访客看的人，访客拿到的展柜是空的", async () => {
    const member = await person();
    const res = await api.me.$patch(
      { json: { showcase: "## 关于我\n\n![照片](https://example.com/me.png)", pins: [] } },
      member.who,
    );
    expect(res.status).toBe(200);
    const { showcase_html } = await showcase(member.id);
    expect(showcase_html).toContain("<h2>关于我</h2>");
    expect(showcase_html).not.toContain("<img");
    expect(showcase_html).toContain('href="https://example.com/me.png"');

    await api.me.$patch({ json: { hide_from_guests: true } }, member.who);
    expect(await showcase(member.id)).toEqual({ showcase_html: null, pins: [] });
    expect((await showcase(member.id, member.who)).showcase_html).not.toBeNull();
  });

  test("版主能清除别人的状态和展柜，要写理由；普通成员不能", async () => {
    const member = await person();
    const moderator = as(await login((await createUser("moderator")).id));
    await api.me.$patch(
      {
        json: {
          user_status: { emoji: "😈", text: "不合适的话", until: null },
          showcase: "不合适的介绍",
        },
      },
      member.who,
    );
    const clear = (item: "status" | "showcase", who: Who, reason = "不合适") =>
      api.users[":user"].customization[":item"].$delete(
        { param: { user: String(member.id), item }, json: { reason } },
        who,
      );
    expect((await clear("status", (await person()).who)).status).toBe(403);
    expect((await clear("status", moderator, "")).status).toBe(400);
    expect((await clear("status", moderator)).status).toBe(204);
    expect((await clear("showcase", moderator)).status).toBe(204);
    expect((await card(member.id)).user_status).toBeNull();
    expect((await showcase(member.id)).showcase_html).toBeNull();
    const logged = await db
      .selectFrom("audit_logs")
      .select("data")
      .where("action", "=", "user.clear")
      .where("target_id", "=", member.id)
      .execute();
    expect(logged).toHaveLength(2);
  });
});
