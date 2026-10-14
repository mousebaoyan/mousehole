import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

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
    const { id } = await createUser();
    if (name === "first") ids.first = id;
    people[name] = as(await login(id));
  }
  await api.boards.$post({ json: { slug: "polls", name: "投票" } }, people.admin);
});

type PollInput = {
  options: string[];
  multiple?: boolean;
  max_choices?: number | null;
  anonymous?: boolean;
  results?: "voted" | "always";
};

async function newPoll(poll: PollInput) {
  const res = await api.threads.$post(
    {
      json: {
        board: "polls",
        title: "大家报了几个夏令营",
        content: { markdown: "说明" },
        kind: "poll",
        poll,
      },
    },
    people.author,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const thread = await res.json();
  if (!thread.poll) throw new Error("no poll");
  return { id: thread.id, options: thread.poll.options.map((o) => o.id) };
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

  test("结束后不能再投：楼主和版主能提前结束，到了截止时间也结束", async () => {
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

    const timed = await newPoll({ options: ["能", "不能"] });
    await db
      .updateTable("polls")
      .set({ closes_at: sql<Date>`now() - interval '1 minute'` })
      .where("thread_id", "=", timed.id)
      .execute();
    expect((await vote(timed.id, [timed.options[0]], people.first)).status).toBe(403);
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
