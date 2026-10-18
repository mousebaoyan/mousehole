import type { Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { env } from "../../platform/env.ts";
import { recordEvent } from "../events/service.ts";
import { anonymousBrief } from "../users/service.ts";

// Events for the bot plugin about threads and floors, written in the transaction that makes the
// change; see docs/api.md §5. People in them carry their QQ number, so the plugin can @ them;
// someone writing anonymously is only their number in the thread (design §8.12).

function link(threadId: number, floor: number) {
  return `${env.PUBLIC_URL}/t/${threadId}${floor > 1 ? `?floor=${floor}` : ""}`;
}

async function person(trx: Transaction<DB>, id: number) {
  return trx
    .selectFrom("users")
    .select(["id", "display_name", "qq"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

// A floor with its thread and board, and its author.
async function floorOf(trx: Transaction<DB>, postId: number) {
  const { alias, ...row } = await trx
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .leftJoin("thread_aliases as alias", (join) =>
      join
        .onRef("alias.thread_id", "=", "posts.thread_id")
        .onRef("alias.user_id", "=", "posts.author_id")
        .on("posts.anonymous", "=", true),
    )
    .select([
      "posts.id",
      "posts.floor",
      "posts.body",
      "posts.author_id",
      "posts.reply_to_id",
      "threads.id as thread_id",
      "threads.title",
      "threads.kind",
      "boards.slug as board_slug",
      "boards.name as board_name",
      "alias.number as alias",
    ])
    .where("posts.id", "=", postId)
    .executeTakeFirstOrThrow();
  return {
    ...row,
    author: alias === null ? await person(trx, row.author_id) : anonymousBrief(alias),
  };
}

type Floor = Awaited<ReturnType<typeof floorOf>>;

// Who edited or deleted a floor: its anonymous author stays anonymous.
async function doer(trx: Transaction<DB>, f: Floor, userId: number) {
  return userId === f.author_id ? f.author : person(trx, userId);
}

export async function threadCreated(trx: Transaction<DB>, openingPostId: number) {
  const f = await floorOf(trx, openingPostId);
  await recordEvent(trx, "thread.created", {
    thread: { id: f.thread_id, title: f.title, kind: f.kind },
    board: { slug: f.board_slug, name: f.board_name },
    author: f.author,
    url: link(f.thread_id, 1),
  });
}

// With the floor it answers.
export async function postCreated(trx: Transaction<DB>, postId: number) {
  const f = await floorOf(trx, postId);
  const target = f.reply_to_id === null ? null : await floorOf(trx, f.reply_to_id);
  await recordEvent(trx, "post.created", {
    post: { id: f.id, floor: f.floor, body: f.body },
    thread: { id: f.thread_id, title: f.title },
    author: f.author,
    reply_to: target && {
      id: target.id,
      floor: target.floor,
      author: target.author,
    },
    url: link(f.thread_id, f.floor),
  });
}

// With the answer and who wrote it; the plugin may tell the group the question is answered.
export async function threadSolved(trx: Transaction<DB>, answerId: number) {
  const f = await floorOf(trx, answerId);
  await recordEvent(trx, "thread.solved", {
    thread: { id: f.thread_id, title: f.title },
    post: { id: f.id, floor: f.floor, body: f.body },
    answerer: f.author,
    url: link(f.thread_id, f.floor),
  });
}

export async function postUpdated(trx: Transaction<DB>, postId: number, editorId: number) {
  const f = await floorOf(trx, postId);
  await recordEvent(trx, "post.updated", {
    post: { id: f.id, floor: f.floor, body: f.body },
    thread: { id: f.thread_id, title: f.title },
    editor: await doer(trx, f, editorId),
  });
}

// Deleted, or hidden by a moderator with a reason.
export async function postDeleted(
  trx: Transaction<DB>,
  postId: number,
  byId: number,
  reason: string | null,
) {
  const f = await floorOf(trx, postId);
  await recordEvent(trx, "post.deleted", {
    post_id: f.id,
    thread_id: f.thread_id,
    floor: f.floor,
    by: await doer(trx, f, byId),
    reason,
  });
}

// Waiting for review in a board reviewed before publishing; a thread's is its opening post. The
// plugin may review it and set its status.
export async function contentPending(trx: Transaction<DB>, postId: number) {
  const f = await floorOf(trx, postId);
  await recordEvent(trx, "content.pending", {
    thread: { id: f.thread_id, title: f.title },
    board: { slug: f.board_slug, name: f.board_name },
    post: { id: f.id, floor: f.floor, body: f.body },
    author: f.author,
    url: link(f.thread_id, f.floor),
  });
}

// Told of as the deletion of its opening post.
export async function threadDeleted(
  trx: Transaction<DB>,
  threadId: number,
  byId: number,
  reason: string | null,
) {
  const opening = await trx
    .selectFrom("posts")
    .select("id")
    .where("thread_id", "=", threadId)
    .where("floor", "=", 1)
    .executeTakeFirstOrThrow();
  await postDeleted(trx, opening.id, byId, reason);
}

// A lottery drawn: who won each prize, so the plugin can announce it in a group and @ them.
export async function lotteryDrawn(
  trx: Transaction<DB>,
  lottery: {
    thread: { id: number; title: string };
    authorId: number;
    prizes: { name: string; winners: number[] }[];
    entryCount: number;
  },
) {
  const prizes = [];
  for (const p of lottery.prizes) {
    prizes.push({
      name: p.name,
      winners: await Promise.all(p.winners.map((id) => person(trx, id))),
    });
  }
  await recordEvent(trx, "lottery.drawn", {
    thread: lottery.thread,
    author: await person(trx, lottery.authorId),
    prizes,
    entry_count: lottery.entryCount,
    url: link(lottery.thread.id, 1),
  });
}

// A thread merged into another (design §8.20): the plugin goes on in the one kept. Its opening
// post, a floor there now, is where the link leads.
export async function threadMerged(
  trx: Transaction<DB>,
  threadId: number,
  openingPostId: number,
  byId: number,
) {
  const f = await floorOf(trx, openingPostId);
  await recordEvent(trx, "thread.merged", {
    thread_id: threadId,
    into: { id: f.thread_id, title: f.title, kind: f.kind },
    board: { slug: f.board_slug, name: f.board_name },
    by: await person(trx, byId),
    url: link(f.thread_id, f.floor),
  });
}
