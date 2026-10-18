import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

async function person(level: number, role: "user" | "moderator" | "admin" = "user") {
  const { id } = await createUser(role, level);
  return { id, who: as(await login(id)) };
}

let admin: Who;

beforeAll(async () => {
  admin = (await person(0, "admin")).who;
  await api.boards.$post({ json: { slug: "sg", name: "建议" } }, admin);
  await api.boards.$post({ json: { slug: "sg2", name: "建议二" } }, admin);
  await api.boards.$post(
    { json: { slug: "sg-staff", name: "公告", post_role: "moderator" } },
    admin,
  );
  await api.tags.$post({ json: { name: "建议标签", kind: "topic" } }, admin);
});

async function threadBy(who: Who, anonymous = false) {
  const res = await api.threads.$post(
    {
      json: { board: "sg", title: "分错了版块的帖子", content: { markdown: "正文" }, anonymous },
    },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

function suggest(
  id: number,
  who: Who,
  json: { title?: string; board?: string; tags?: string[]; reason?: string },
) {
  return api.threads[":id"].suggestions.$post({ param: { id: String(id) }, json }, who);
}

async function detail(id: number, who: Who) {
  const res = await api.threads[":id"].$get({ param: { id: String(id) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function decide(id: number, who: Who, status: "accepted" | "rejected") {
  return api.suggestions[":id"].$patch({ param: { id: String(id) }, json: { status } }, who);
}

async function told(who: Who) {
  const res = await api.notifications.$get({ query: {} }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items
    .filter((n) => n.type === "suggestion")
    .map((n) => [n.data.kind, n.thread?.id]);
}

async function waiting() {
  const res = await api.admin.suggestions.$get({ query: {} }, admin);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((s) => s.id);
}

describe("修改建议", () => {
  test("L3 建议修改等级比自己低的人的帖子；版块只能选自己能发帖的，一项没改、同级、匿名的不行", async () => {
    const [low, peer, l3, l2, moderator] = await Promise.all([
      person(1),
      person(3),
      person(3),
      person(2),
      person(0, "moderator"),
    ]);
    const thread = await threadBy(low.who);
    expect((await suggest(thread, l2.who, { board: "sg2" })).status).toBe(403);
    expect((await suggest(thread, l3.who, { board: "sg-staff" })).status).toBe(403);
    expect((await suggest(thread, l3.who, { title: "分错了版块的帖子", board: "sg" })).status).toBe(
      400,
    );
    expect((await suggest(thread, l3.who, { board: "sg2", reason: "不是这个版块" })).status).toBe(
      204,
    );
    expect((await suggest(thread, l3.who, { title: "又想到一个标题" })).status).toBe(409);

    for (const author of [peer, moderator]) {
      expect((await suggest(await threadBy(author.who), l3.who, { board: "sg2" })).status).toBe(
        403,
      );
    }
    const hidden = await threadBy(low.who, true);
    expect((await suggest(hidden, l3.who, { board: "sg2" })).status).toBe(403);

    // Only its author and moderators see what waits on it.
    expect((await detail(thread, l3.who)).suggestions).toBeUndefined();
    expect((await detail(thread, low.who)).suggestions).toMatchObject([
      {
        user: { id: l3.id },
        title: null,
        board: { slug: "sg2" },
        tags: null,
        reason: "不是这个版块",
      },
    ]);
    expect(await told(low.who)).toEqual([["new", thread]]);
  });

  test("楼主同意后照建议修改，标题算提建议的人改的；只告诉提建议的人，后台不再列出", async () => {
    const [low, l3] = await Promise.all([person(1), person(3)]);
    const thread = await threadBy(low.who);
    await suggest(thread, l3.who, { title: "更清楚的新标题", board: "sg2", tags: ["建议标签"] });
    const [suggestion] = (await detail(thread, low.who)).suggestions ?? [];
    expect(await waiting()).toContain(suggestion.id);

    expect((await decide(suggestion.id, l3.who, "accepted")).status).toBe(403);
    expect((await decide(suggestion.id, low.who, "accepted")).status).toBe(204);
    expect((await decide(suggestion.id, low.who, "rejected")).status).toBe(409);
    expect(await detail(thread, low.who)).toMatchObject({
      title: "更清楚的新标题",
      board: { slug: "sg2" },
      tags: ["建议标签"],
      suggestions: [],
    });
    expect(await waiting()).not.toContain(suggestion.id);

    const opening = await api.threads[":id"].posts.$get({
      param: { id: String(thread) },
      query: {},
    });
    if (!opening.ok) throw new Error(`status ${opening.status}`);
    const revisions = await api.posts[":id"].revisions.$get(
      { param: { id: String((await opening.json()).items[0].id) } },
      low.who,
    );
    if (!revisions.ok) throw new Error(`status ${revisions.status}`);
    expect((await revisions.json()).items).toMatchObject([
      { title: "分错了版块的帖子", editor: { id: l3.id } },
    ]);
    expect(await told(l3.who)).toEqual([["accepted", thread]]);
    expect(await told(low.who)).toEqual([["new", thread]]);
  });

  test("版主同意的楼主也收到通知；未同意的不改，只告诉提建议的人", async () => {
    const [low, l3, other, moderator] = await Promise.all([
      person(1),
      person(3),
      person(3),
      person(0, "moderator"),
    ]);
    const thread = await threadBy(low.who);
    await suggest(thread, l3.who, { title: "版主同意的标题" });
    await suggest(thread, other.who, { board: "sg2" });
    const [first, second] = (await detail(thread, moderator.who)).suggestions ?? [];

    expect((await decide(first.id, moderator.who, "accepted")).status).toBe(204);
    expect((await decide(second.id, moderator.who, "rejected")).status).toBe(204);
    expect(await detail(thread, low.who)).toMatchObject({
      title: "版主同意的标题",
      board: { slug: "sg" },
    });
    expect(await told(l3.who)).toEqual([["accepted", thread]]);
    expect(await told(other.who)).toEqual([["rejected", thread]]);
    expect(await told(low.who)).toEqual([
      ["applied", thread],
      ["new", thread],
      ["new", thread],
    ]);
  });
});
