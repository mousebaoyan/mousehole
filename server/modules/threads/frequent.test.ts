import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { countFrequent } from "./service.ts";

const api = testClient(app).api.v1;

// Askers a–d, and x and y who answer.
const people: Record<string, ReturnType<typeof as>> = {};
const ids: Record<string, number> = {};

// Half past the hour, Beijing time, that many days ago.
function beijing(daysAgo: number, hour = 12) {
  const today = new Date(Date.now() + 8 * 3_600_000);
  return new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - daysAgo,
      hour - 8,
      30,
    ),
  );
}

// A floor after the opening one: by whom and when, replying to floor `answers`, or to none when it
// asks again. Each reads as a question unless it `says` something else, so that what keeps it out
// is the one thing under test; `anonymous` is its author's choice where the thread leaves it to them.
type Floor = {
  by: string;
  at: Date;
  answers?: number;
  says?: string;
  anonymous?: boolean;
  removed?: "deleted" | "hidden";
};

// A question its asker opened at `at`, with these floors. Posted as a discussion, as a question
// costs coins, then made one.
async function question(
  board: string,
  opening: { by: string; at: Date },
  floors: Floor[],
  {
    tags = [],
    kind = "question",
    anonymous,
  }: { tags?: string[]; kind?: "question" | "discussion"; anonymous?: boolean } = {},
) {
  const res = await api.threads.$post(
    { json: { board, title: "夏令营要准备什么", content: { markdown: "正文" }, tags, anonymous } },
    people[opening.by],
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id } = await res.json();
  await db.updateTable("threads").set({ kind }).where("id", "=", id).execute();
  for (const floor of floors) {
    const markdown = floor.says ?? "还有人知道吗？";
    const reply = await api.threads[":id"].posts.$post(
      { param: { id: String(id) }, json: { content: { markdown }, anonymous: floor.anonymous } },
      people[floor.by],
    );
    if (!reply.ok) throw new Error(`status ${reply.status}`);
  }
  const all: Floor[] = [opening, ...floors];
  for (const [i, { at, answers, removed }] of all.entries()) {
    await db
      .updateTable("posts")
      .set((eb) => ({
        created_at: at,
        deleted_at: removed === "deleted" ? at : null,
        status: removed === "hidden" ? "hidden" : "visible",
        reply_to_id:
          answers === undefined
            ? null
            : eb
                .selectFrom("posts as to")
                .select("to.id")
                .where("to.thread_id", "=", id)
                .where("to.floor", "=", answers),
      }))
      .where("thread_id", "=", id)
      .where("floor", "=", i + 1)
      .execute();
  }
  return id;
}

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  for (const name of ["a", "b", "c", "d", "x", "y"]) {
    people[name] = as(await login((await createUser()).id));
  }
  await api.boards.$post({ json: { slug: "faq", name: "问答" } }, admin);
  await api.boards.$post({ json: { slug: "inner", name: "内部", visibility: "members" } }, admin);
  for (const tag of [
    { name: "夏令营", kind: "topic" as const },
    { name: "预推免", kind: "topic" as const },
    { name: "南京大学", kind: "school" as const },
  ]) {
    await api.tags.$post({ json: tag }, admin);
  }

  // Asked by four, the first long ago.
  ids.four = await question(
    "faq",
    { by: "a", at: beijing(200) },
    [
      { by: "x", at: beijing(200, 13), answers: 1 },
      { by: "b", at: beijing(30) },
      { by: "y", at: beijing(30, 13), answers: 3 },
      { by: "c", at: beijing(10) },
      { by: "x", at: beijing(10, 13), answers: 5 },
      { by: "d", at: beijing(2) },
      { by: "y", at: beijing(2, 13), answers: 7 },
    ],
    { tags: ["夏令营", "南京大学"] },
  );
  ids.three = await question(
    "faq",
    { by: "a", at: beijing(40) },
    [
      { by: "b", at: beijing(20) },
      { by: "x", at: beijing(20, 13), answers: 2 },
      { by: "c", at: beijing(5) },
      { by: "y", at: beijing(5, 13), answers: 4 },
    ],
    { tags: ["夏令营", "预推免"] },
  );
  // 23:30 and 00:30 in Beijing fall on one day in UTC.
  ids.midnight = await question("faq", { by: "a", at: beijing(6, 23) }, [
    { by: "b", at: beijing(5, 0) },
    { by: "x", at: beijing(5, 1), answers: 2 },
    { by: "c", at: beijing(3) },
    { by: "x", at: beijing(3, 13), answers: 4 },
  ]);
  ids.members = await question(
    "inner",
    { by: "a", at: beijing(30) },
    [
      { by: "b", at: beijing(10) },
      { by: "x", at: beijing(10, 13), answers: 2 },
      { by: "c", at: beijing(1) },
      { by: "y", at: beijing(1, 13), answers: 4 },
    ],
    { tags: ["夏令营"] },
  );
  // Four as readers tell them apart. a asked anonymously, which leaves the others to choose for
  // each floor: b named and b anonymously are two, and so are c asking anonymously and c
  // answering named.
  ids.masked = await question(
    "faq",
    { by: "a", at: beijing(30) },
    [
      { by: "b", at: beijing(20) },
      { by: "x", at: beijing(20, 13), answers: 2 },
      { by: "b", at: beijing(10), anonymous: true },
      { by: "y", at: beijing(10, 13), answers: 4 },
      { by: "c", at: beijing(5), anonymous: true },
      { by: "c", at: beijing(5, 13), answers: 6 },
    ],
    { anonymous: true },
  );

  // None of these is listed. Most are asked by a and b and have one more floor that, counted, would
  // make a third asker on a third day; the others say why they fall short.
  const twoAsked = (more: Floor[]) => [
    { by: "b", at: beijing(20) },
    { by: "x", at: beijing(20, 13), answers: 2 },
    ...more,
  ];
  ids.unanswered = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([{ by: "c", at: beijing(10) }]),
  );
  ids.answeredByAsker = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([
      { by: "c", at: beijing(10) },
      { by: "a", at: beijing(10, 13), answers: 4 },
    ]),
  );
  ids.answeredBySelf = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([
      { by: "c", at: beijing(10) },
      { by: "c", at: beijing(10, 13), answers: 4 },
    ]),
  );
  // On another day, an answer to the opening post that someone took up.
  ids.notAsking = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([
      { by: "c", at: beijing(10), says: "我去年准备了简历和推荐信" },
      { by: "y", at: beijing(10, 13), answers: 4 },
    ]),
  );
  ids.aReply = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([
      { by: "c", at: beijing(10), answers: 2 },
      { by: "y", at: beijing(10, 13), answers: 4 },
    ]),
  );
  // Three asked, on two days, so that one more day would list it: the asker's own question on
  // another day isn't one.
  ids.askerAgain = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([
      { by: "c", at: beijing(20, 18) },
      { by: "y", at: beijing(20, 19), answers: 4 },
      { by: "a", at: beijing(10) },
      { by: "y", at: beijing(10, 13), answers: 6 },
    ]),
  );
  // Two asked, on three days, so that one more asker would list it: on the opening's day, a
  // floor others answered is an answer that started a talk, not asking again.
  ids.sameDay = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([
      { by: "b", at: beijing(10) },
      { by: "y", at: beijing(10, 13), answers: 4 },
      { by: "c", at: beijing(30, 18) },
      { by: "y", at: beijing(30, 19), answers: 6 },
    ]),
  );
  for (const [name, removed] of [
    ["deleted", { asking: "deleted" }],
    ["hidden", { asking: "hidden" }],
    ["answerDeleted", { answer: "deleted" }],
    ["answerHidden", { answer: "hidden" }],
  ] as const) {
    ids[name] = await question(
      "faq",
      { by: "a", at: beijing(30) },
      twoAsked([
        { by: "c", at: beijing(10), removed: removed.asking },
        { by: "y", at: beijing(10, 13), answers: 4, removed: removed.answer },
      ]),
    );
  }
  // By four people, over two days, as when a school's places run out.
  ids.burst = await question("faq", { by: "a", at: beijing(3) }, [
    { by: "b", at: beijing(2, 9) },
    { by: "x", at: beijing(2, 10), answers: 2 },
    { by: "c", at: beijing(2, 11) },
    { by: "x", at: beijing(2, 12), answers: 4 },
    { by: "d", at: beijing(2, 13) },
    { by: "y", at: beijing(2, 14), answers: 6 },
  ]);
  ids.oneAgain = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([
      { by: "b", at: beijing(10) },
      { by: "y", at: beijing(10, 13), answers: 4 },
    ]),
  );
  ids.stale = await question("faq", { by: "a", at: beijing(200) }, [
    { by: "b", at: beijing(150) },
    { by: "x", at: beijing(150, 13), answers: 2 },
    { by: "c", at: beijing(100) },
    { by: "y", at: beijing(100, 13), answers: 4 },
  ]);
  // A daily check-in thread, say.
  ids.discussion = await question(
    "faq",
    { by: "a", at: beijing(30) },
    twoAsked([
      { by: "c", at: beijing(10) },
      { by: "y", at: beijing(10, 13), answers: 4 },
    ]),
    { kind: "discussion" },
  );

  await db
    .insertInto("thread_summaries")
    .values({ thread_id: ids.four, lead: "问的是夏令营要准备哪些材料", points: JSON.stringify([]) })
    .execute();
  await api.admin.settings.$patch({ json: { site: { summaries: true } } }, await ownerSession());
  // As the hourly job does.
  await countFrequent();
}, 60_000);

async function frequent(query: { tag?: string }, who?: (typeof people)[string]) {
  const res = await api.threads.frequent.$get({ query }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("高频问题", () => {
  test("楼主和后来在别的日子又问一遍、有别人回答的人算问过，按读者看到的身份数；至少 3 人、北京时间至少 3 天、近 90 天还有人问；人多的在前，一样多的最近有人问的在前", async () => {
    const page = await frequent({}, people.x);
    expect(page.items.map((i) => [i.thread.id, i.askers])).toEqual([
      [ids.four, 4],
      [ids.masked, 4],
      [ids.members, 3],
      [ids.midnight, 3],
      [ids.three, 3],
    ]);
    expect(page.next_cursor).toBeNull();
  });

  test("只列看的人能打开的，话题标签按其中的帖子数排，院校和方向不列", async () => {
    const guest = await frequent({});
    expect(guest.items.map((i) => i.thread.id)).toEqual([
      ids.four,
      ids.masked,
      ids.midnight,
      ids.three,
    ]);
    expect(guest.topics).toEqual([
      { name: "夏令营", count: 2 },
      { name: "预推免", count: 1 },
    ]);
    expect((await frequent({}, people.x)).topics).toEqual([
      { name: "夏令营", count: 3 },
      { name: "预推免", count: 1 },
    ]);
    const tagged = await frequent({ tag: "预推免" });
    expect(tagged.items.map((i) => i.thread.id)).toEqual([ids.three]);
  });

  test("带 AI 总结的第一句", async () => {
    const page = await frequent({}, people.x);
    expect(page.items.map((i) => i.lead)).toEqual([
      "问的是夏令营要准备哪些材料",
      null,
      null,
      null,
      null,
    ]);
  });
});
