import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who = as("");
let moderator: Who = as("");
let first: Who = as("");
let second: Who = as("");

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  moderator = as(await login((await createUser("moderator")).id));
  first = as(await login((await createUser()).id));
  second = as(await login((await createUser()).id));
  await api.boards.$post({ json: { slug: "a", name: "收录" } }, admin);
});

// A thread with the given replies; those marked true are made to have come from the group chats.
async function floorsOf(archived: boolean[]) {
  const res = await api.threads.$post(
    { json: { board: "a", title: "群里收录的问题", content: { markdown: "问题" } } },
    first,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const thread = String((await res.json()).id);
  const ids: number[] = [];
  for (const [i, qq] of archived.entries()) {
    const reply = await api.threads[":id"].posts.$post(
      { param: { id: thread }, json: { content: { markdown: `回答 ${i}` } } },
      second,
    );
    if (!reply.ok) throw new Error(`status ${reply.status}`);
    const { id } = await reply.json();
    if (qq) await db.updateTable("posts").set({ via: "qq" }).where("id", "=", id).execute();
    ids.push(id);
  }
  return { thread, ids };
}

function flag(id: number, who: Who) {
  return api.posts[":id"]["archive-flag"].$put({ param: { id: String(id) } }, who);
}

async function counted() {
  const res = await api.admin["archive-flags"].count.$get({}, moderator);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).count;
}

async function flagged() {
  const res = await api.admin["archive-flags"].$get({}, moderator);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((f) => [f.post.id, f.count]);
}

describe("收录有误", () => {
  test("点一下反馈、再点一下撤回，楼层里带着自己的反馈；不是群聊收录的楼层不能反馈", async () => {
    const { thread, ids } = await floorsOf([true, false]);
    const [archived, typed] = ids;
    expect((await flag(archived, first)).status).toBe(204);
    expect((await flag(archived, first)).status).toBe(204);
    expect((await flag(typed, first)).status).toBe(400);

    const mine = async (who: Who) => {
      const res = await api.threads[":id"].posts.$get({ param: { id: thread }, query: {} }, who);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items.map((p) => p.my_archive_flag);
    };
    expect(await mine(first)).toEqual([undefined, true, undefined]);
    expect(await mine(second)).toEqual([undefined, false, undefined]);

    const param = { id: String(archived) };
    expect((await api.posts[":id"]["archive-flag"].$delete({ param }, first)).status).toBe(204);
    expect(await mine(first)).toEqual([undefined, false, undefined]);
  });

  test("版主看到反馈多的在前；隐藏的楼层不列出，清掉反馈后不再列出；普通成员看不到", async () => {
    const before = await counted();
    const { ids } = await floorsOf([true, true]);
    const [more, fewer] = ids;
    await flag(fewer, first);
    await flag(more, first);
    await flag(more, second);
    expect((await api.admin["archive-flags"].$get({}, first)).status).toBe(403);
    expect(await flagged()).toEqual(expect.arrayContaining([[more, 2]]));
    const order = (await flagged()).map(([id]) => id);
    expect(order.indexOf(more)).toBeLessThan(order.indexOf(fewer));
    expect(await counted()).toBe(before + 2);

    const hidden = await api.posts[":id"].$patch(
      { param: { id: String(fewer) }, json: { status: "hidden", reason: "收录有误" } },
      moderator,
    );
    expect(hidden.status).toBe(200);
    expect((await flagged()).map(([id]) => id)).not.toContain(fewer);
    expect(await counted()).toBe(before + 1);

    const param = { id: String(more) };
    expect((await api.admin["archive-flags"][":id"].$delete({ param }, moderator)).status).toBe(
      204,
    );
    expect((await flagged()).map(([id]) => id)).not.toContain(more);
    expect(await counted()).toBe(before);
    expect((await api.admin["archive-flags"][":id"].$delete({ param }, moderator)).status).toBe(
      404,
    );
  });
});
