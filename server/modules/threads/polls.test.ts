import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

type Who = { headers?: Record<string, string> };

const people = { admin: as(""), moderator: as(""), author: as(""), first: as(""), second: as("") };
const ids = { first: 0 };
const guest = {};

beforeAll(async () => {
  for (const role of ["admin", "moderator"] as const) {
    people[role] = as(await login((await createUser(role)).id));
  }
  for (const name of ["author", "first", "second"] as const) {
    const { id } = await createUser("user", name === "author" ? 2 : 1);
    if (name === "first") ids.first = id;
    people[name] = as(await login(id));
  }
  await api.boards.$post({ json: { slug: "polls", name: "投票" } }, people.admin);
});

type PollInput = {
  options: string[];
  rows?: string[] | null;
  multiple?: boolean;
  max_choices?: number | null;
  anonymous?: boolean;
  results?: "voted" | "always";
  closes_at?: number | null;
};

function postPoll(
  poll: PollInput | { preset: "positioning"; rows: string[] },
  who: Who = people.author,
) {
  return api.threads.$post(
    {
      json: {
        board: "polls",
        title: "大家报了几个夏令营",
        content: { markdown: "说明" },
        kind: "poll",
        poll,
      },
    },
    who,
  );
}

async function newPoll(poll: PollInput) {
  const res = await postPoll(poll);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const thread = await res.json();
  if (!thread.poll) throw new Error("no poll");
  return { id: thread.id, options: thread.poll.options.map((o) => o.id), poll: thread.poll };
}

function vote(thread: number, options: number[], who: Who) {
  return api.threads[":id"].poll.vote.$put(
    { param: { id: String(thread) }, json: { options } },
    who,
  );
}

async function voted(thread: number, options: number[], who: Who) {
  const res = await vote(thread, options, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function pollOf(thread: number, who: Who) {
  const res = await api.threads[":id"].$get({ param: { id: String(thread) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { poll } = await res.json();
  if (!poll) throw new Error("no poll");
  return poll;
}

function voters(thread: number, option: number, who: Who) {
  return api.threads[":id"].poll.options[":option"].voters.$get(
    { param: { id: String(thread), option: String(option) } },
    who,
  );
}

const votes = (poll: { options: { votes: number | null }[] }) => poll.options.map((o) => o.votes);

describe("投票", () => {
  test("投票帖要带投票，别的类型不能带", async () => {
    const json = { board: "polls", title: "这个帖子的类型", content: { markdown: "正文" } };
    const missing = await api.threads.$post({ json: { ...json, kind: "poll" } }, people.author);
    expect(missing.status).toBe(400);
    const extra = await api.threads.$post(
      { json: { ...json, poll: { options: ["甲", "乙"] } } },
      people.author,
    );
    expect(extra.status).toBe(400);
  });

  test("单选：投过才看得到票数，改票换掉原来的，撤票后不算人数", async () => {
    const { id, options } = await newPoll({ options: ["一个", "两个", "三个以上"] });
    const [one, two] = options;
    expect(await pollOf(id, people.second)).toMatchObject({
      voter_count: 0,
      my_votes: [],
      options: [{ votes: null }, { votes: null }, { votes: null }],
    });
    expect((await vote(id, [one, two], people.first)).status).toBe(400);

    expect(votes(await voted(id, [one], people.first))).toEqual([1, 0, 0]);
    expect(await voted(id, [two], people.first)).toMatchObject({ voter_count: 1, my_votes: [two] });
    expect(votes(await voted(id, [two], people.second))).toEqual([0, 2, 0]);
    expect(await voted(id, [], people.first)).toMatchObject({
      voter_count: 1,
      my_votes: [],
      options: [{ votes: null }, { votes: null }, { votes: null }],
    });
    expect(votes(await pollOf(id, people.second))).toEqual([0, 1, 0]);
  });

  test("多选限制项数，选项要在这个投票里；随时公开的结果没投也看得到", async () => {
    const other = await newPoll({ options: ["甲", "乙"] });
    const { id, options } = await newPoll({
      options: ["清华", "北大", "浙大", "复旦"],
      multiple: true,
      max_choices: 2,
      results: "always",
    });
    expect((await vote(id, options.slice(0, 3), people.first)).status).toBe(400);
    expect((await vote(id, [options[0], other.options[0]], people.first)).status).toBe(400);
    await voted(id, [options[0], options[2]], people.first);
    expect(await pollOf(id, people.second)).toMatchObject({ voter_count: 1, my_votes: [] });
    expect(votes(await pollOf(id, guest))).toEqual([1, 0, 1, 0]);
  });

  test("结束后不能再投：楼主和版主能提前结束，到了截止时间也结束；截止时间在 10 分钟以后、一年以内", async () => {
    const { id, options } = await newPoll({ options: ["能", "不能"] });
    const param = { id: String(id) };
    expect((await api.threads[":id"].poll.close.$post({ param }, people.first)).status).toBe(403);
    const closed = await api.threads[":id"].poll.close.$post({ param }, people.author);
    if (!closed.ok) throw new Error(`status ${closed.status}`);
    expect(await closed.json()).toMatchObject({
      closed: true,
      options: [{ votes: 0 }, { votes: 0 }],
    });
    expect((await vote(id, [options[0]], people.first)).status).toBe(403);

    const now = Math.floor(Date.now() / 1000);
    for (const closes_at of [now + 60, now + 400 * 86_400]) {
      expect((await postPoll({ options: ["能", "不能"], closes_at })).status).toBe(400);
    }
    const timed = await newPoll({ options: ["能", "不能"], closes_at: now + 3600 });
    expect(timed.poll).toMatchObject({ closes_at: now + 3600, closed: false });
    await db
      .updateTable("polls")
      .set({ closes_at: sql<Date>`now() - interval '1 minute'` })
      .where("thread_id", "=", timed.id)
      .execute();
    expect((await vote(timed.id, [timed.options[0]], people.first)).status).toBe(403);
  });

  test("分行投票：每行用同一组选项，每行最多选一项，可以只投几行，票按行统计", async () => {
    expect(
      (await postPoll({ options: ["能", "不能"], rows: ["浙大", "南大"], multiple: true })).status,
    ).toBe(400);
    expect((await postPoll({ options: ["能", "不能"], rows: ["浙大", "浙大"] })).status).toBe(400);
    const { id, poll } = await newPoll({ options: ["能", "不能"], rows: ["浙大", "南大"] });
    expect(poll).toMatchObject({
      rows: ["浙大", "南大"],
      preset: null,
      options: [
        { row: 0, label: "能" },
        { row: 0, label: "不能" },
        { row: 1, label: "能" },
        { row: 1, label: "不能" },
      ],
    });
    const [zjuYes, zjuNo, njuYes] = poll.options.map((o) => o.id);
    expect((await vote(id, [zjuYes, zjuNo], people.first)).status).toBe(400);
    expect(await voted(id, [zjuNo], people.first)).toMatchObject({ voter_count: 1 });
    expect(votes(await voted(id, [zjuYes, njuYes], people.second))).toEqual([1, 1, 1, 0]);
  });

  test("保研定位：L2 以下也能发，选项和匿名由论坛定，不能自己带选项", async () => {
    expect((await postPoll({ options: ["能", "不能"] }, people.first)).status).toBe(403);
    // Past the client's types, as a hand-written request may be.
    const options = await app.request("/api/v1/threads", {
      method: "POST",
      headers: { ...people.first.headers, "content-type": "application/json" },
      body: JSON.stringify({
        board: "polls",
        title: "求定位：浙大等",
        content: { markdown: "背景" },
        kind: "poll",
        poll: { preset: "positioning", rows: ["浙大"], options: ["能", "不能"] },
      }),
    });
    expect(options.status).toBe(400);
    const res = await postPoll({ preset: "positioning", rows: ["浙大", "南大"] }, people.first);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { poll } = await res.json();
    expect(poll).toMatchObject({
      preset: "positioning",
      rows: ["浙大", "南大"],
      multiple: false,
      anonymous: true,
      results: "voted",
    });
    const row = poll?.options.filter((o) => o.row === 1) ?? [];
    expect(row.map((o) => o.label)).toEqual([
      "随便去",
      "努把力",
      "看运气",
      "有点难",
      "几乎不可能",
      "不清楚",
    ]);
    expect(row.map((o) => o.abstain)).toEqual([false, false, false, false, false, true]);
  });

  test("待投票：他人发的、还在投票、自己没投过的投票帖，不论发了多久，数量和列表一致；投了不清楚也算投过", async () => {
    const unvoted = async (who: Who) => {
      const query = { board: "polls" };
      const [list, counts] = await Promise.all([
        api.threads.$get({ query: { ...query, view: "unvoted" } }, who),
        api.threads.counts.$get({ query }, who),
      ]);
      if (!list.ok || !counts.ok) throw new Error(`status ${list.status} ${counts.status}`);
      const listed = (await list.json()).items.map((t) => t.id);
      expect((await counts.json()).unvoted).toBe(listed.length);
      return listed;
    };
    const plain = await newPoll({ options: ["去", "不去"] });
    const res = await postPoll({ preset: "positioning", rows: ["浙大", "南大"] });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { id, poll } = await res.json();
    expect(await unvoted(people.first)).toEqual(expect.arrayContaining([plain.id, id]));
    expect(await unvoted(people.author)).not.toContain(id);
    const guests = await api.threads.$get({ query: { view: "unvoted" } }, guest);
    expect(guests.status).toBe(401);

    const unsure = poll?.options.find((o) => o.abstain)?.id ?? 0;
    await voted(id, [unsure], people.first);
    expect(await unvoted(people.first)).not.toContain(id);
    expect(await unvoted(people.second)).toContain(id);

    await db
      .updateTable("threads")
      .set({ created_at: sql<Date>`now() - interval '60 days'` })
      .where("id", "=", id)
      .execute();
    expect(await unvoted(people.second)).toContain(id);

    const param = { id: String(plain.id) };
    await api.threads[":id"].poll.close.$post({ param }, people.author);
    expect(await unvoted(people.second)).not.toContain(plain.id);
  });

  test("实名投票投过的人能看谁投了哪一项；匿名投票和访客看不到", async () => {
    const named = await newPoll({ options: ["去", "不去"] });
    await voted(named.id, [named.options[0]], people.first);
    expect((await voters(named.id, named.options[0], people.second)).status).toBe(403);
    expect((await voters(named.id, named.options[0], guest)).status).toBe(401);
    const res = await voters(named.id, named.options[0], people.first);
    if (!res.ok) throw new Error(`status ${res.status}`);
    expect((await res.json()).items).toMatchObject([{ id: ids.first }]);

    const secret = await newPoll({ options: ["去", "不去"], anonymous: true });
    await voted(secret.id, [secret.options[0]], people.first);
    expect((await voters(secret.id, secret.options[0], people.first)).status).toBe(403);
  });
});

describe("群里的投票汇总", () => {
  test("bot 拿到这段时间里发的、还能投的投票帖和投票人数；结束了的、锁定的、门槛高的版块里的不给", async () => {
    const { id: owner } = await createUser("admin");
    const { token } = await createBotToken(
      { userId: owner, operatorId: null, tokenId: null, ip: null, userAgent: null },
      { name: "插件", botQq: nextQq(), scopes: ["read"] },
    );
    const bot = { headers: { authorization: `Bearer ${token}` } };
    await api.boards.$post(
      { json: { slug: "polls-l3", name: "高阶投票", read_level: 3 } },
      people.admin,
    );
    const since = Math.floor(Date.now() / 1000);
    const made = [];
    for (let i = 0; i < 7; i++) made.push(await newPoll({ options: ["去", "不去"] }));
    const [quiet, popular, closed, expired, locked, guarded, earlier] = made;
    await voted(popular.id, [popular.options[0]], people.first);
    await api.threads[":id"].poll.close.$post({ param: { id: String(closed.id) } }, people.author);
    await db
      .updateTable("polls")
      .set({ closes_at: sql<Date>`now()` })
      .where("thread_id", "=", expired.id)
      .execute();
    await db.updateTable("threads").set({ locked: true }).where("id", "=", locked.id).execute();
    const { id: board } = await db
      .selectFrom("boards")
      .select("id")
      .where("slug", "=", "polls-l3")
      .executeTakeFirstOrThrow();
    await db.updateTable("threads").set({ board_id: board }).where("id", "=", guarded.id).execute();
    await db
      .updateTable("threads")
      .set({ created_at: sql<Date>`now() - interval '1 day'` })
      .where("id", "=", earlier.id)
      .execute();

    const mine = new Set(made.map((p) => p.id));
    const listed = async (query: { since: string; until?: string }) => {
      const res = await api.bot.polls.$get({ query }, bot);
      return (await res.json()).items.filter((i) => mine.has(i.thread.id));
    };
    expect(await listed({ since: String(since) })).toEqual([
      {
        thread: { id: quiet.id, title: "大家报了几个夏令营" },
        voters: 0,
        url: `${env.PUBLIC_URL}/t/${quiet.id}`,
      },
      {
        thread: { id: popular.id, title: "大家报了几个夏令营" },
        voters: 1,
        url: `${env.PUBLIC_URL}/t/${popular.id}`,
      },
    ]);
    expect(await listed({ since: String(since), until: String(since) })).toEqual([]);
  });
});
