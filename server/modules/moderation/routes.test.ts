import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who = as("");
let moderator: Who = as("");
let moderatorId = 0;
let threadId = 0;

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  const mod = await createUser("moderator");
  moderatorId = mod.id;
  moderator = as(await login(mod.id));
  await api.boards.$post({ json: { slug: "m", name: "管理" } }, admin);
  const res = await api.threads.$post(
    { json: { board: "m", title: "大家来讨论", content: { markdown: "主楼" } } },
    admin,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  threadId = (await res.json()).id;
});

async function member() {
  const { id } = await createUser();
  return { id, who: as(await login(id)) };
}

function restrict(id: number, type: "mute" | "ban", who: Who, until: number | null = null) {
  return api.users[":user"].restriction.$put(
    { param: { user: String(id) }, json: { type, until, reason: "刷屏" } },
    who,
  );
}

function reply(who: Who) {
  return api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown: "回复一下" } } },
    who,
  );
}

describe("禁言和封禁", () => {
  test("禁言后不能回复，还能收藏；本人和版主看得到禁言状态，别人看不到；解除后恢复", async () => {
    const m = await member();
    const tomorrow = Math.floor(Date.now() / 1000) + 86_400;
    expect((await restrict(m.id, "mute", moderator, tomorrow)).status).toBe(204);

    const blocked = await reply(m.who);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { code: "muted" } });
    const bookmark = await api.threads[":id"].bookmark.$put(
      { param: { id: String(threadId) } },
      m.who,
    );
    expect(bookmark.status).toBe(204);

    const profile = async (who: Who) => {
      const res = await api.users[":user"].$get({ param: { user: String(m.id) } }, who);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const user = await res.json();
      if (user.members_only) throw new Error("members only");
      return user.restriction;
    };
    expect(await profile(m.who)).toEqual({ type: "mute", until: tomorrow });
    expect(await profile(moderator)).toEqual({ type: "mute", until: tomorrow });
    expect(await profile((await member()).who)).toBeUndefined();

    await api.users[":user"].restriction.$delete(
      { param: { user: String(m.id) }, json: {} },
      moderator,
    );
    expect((await reply(m.who)).status).toBe(201);
  });

  test("到期的禁言不再算", async () => {
    const m = await member();
    await restrict(m.id, "mute", moderator, Math.floor(Date.now() / 1000) + 60);
    await db
      .updateTable("users")
      .set({ restricted_until: new Date(Date.now() - 1000) })
      .where("id", "=", m.id)
      .execute();
    expect((await reply(m.who)).status).toBe(201);
  });

  test("封禁要管理员：封了就下线、登录不了；解除封禁也要管理员", async () => {
    const m = await member();
    expect((await restrict(m.id, "ban", moderator)).status).toBe(403);
    expect((await restrict(m.id, "ban", admin)).status).toBe(204);
    expect((await api.me.$get({}, m.who)).status).toBe(401);
    await expect(login(m.id)).rejects.toThrow("login failed: 403");

    const param = { user: String(m.id) };
    expect(
      (await api.users[":user"].restriction.$delete({ param, json: {} }, moderator)).status,
    ).toBe(403);
    expect((await api.users[":user"].restriction.$delete({ param, json: {} }, admin)).status).toBe(
      204,
    );
    await login(m.id);
  });

  test("版主和管理员不能被禁言", async () => {
    expect((await restrict(moderatorId, "mute", moderator)).status).toBe(403);
  });
});
