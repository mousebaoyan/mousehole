import type { Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { env } from "../../platform/env.ts";
import { excerpt } from "../../platform/markdown.ts";
import { recordEvent } from "../events/service.ts";
import { anonymousBrief } from "../users/service.ts";

// Events for the bot plugin about threads and floors, written in the transaction that makes the
// change; see docs/api.md §5. People in them carry their QQ number, so the plugin can @ them;
// someone writing anonymously is only their number in the thread (design §8.12).

// Characters of a floor in the text the plugin can send to QQ as it is.
const QQ_EXCERPT = 60;

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

// A floor with its thread and board, its author, and the QQ message it came from, if any.
async function floorOf(trx: Transaction<DB>, postId: number) {
  const { chat_type, chat_id, message_id, alias, ...row } = await trx
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .leftJoin("thread_aliases as alias", (join) =>
      join
        .onRef("alias.thread_id", "=", "posts.thread_id")
        .onRef("alias.user_id", "=", "posts.author_id")
        .on("posts.anonymous", "=", true),
    )
    .leftJoin("qq_message_links as link", (join) =>
      join.onRef("link.post_id", "=", "posts.id").on("link.kind", "=", "source"),
    )
    .select([
      "posts.id",
      "posts.floor",
      "posts.body",
      "posts.html",
      "posts.author_id",
      "posts.reply_to_id",
      "threads.id as thread_id",
      "threads.title",
      "threads.kind",
      "boards.slug as board_slug",
      "boards.name as board_name",
      "link.chat_type",
      "link.chat_id",
      "link.message_id",
      "alias.number as alias",
    ])
    .where("posts.id", "=", postId)
    .executeTakeFirstOrThrow();
  return {
    ...row,
    author: alias === null ? await person(trx, row.author_id) : anonymousBrief(alias),
    source:
      chat_type === null || chat_id === null || message_id === null
        ? null
        : { chat_type, chat_id, message_id },
  };
}

type Floor = Awaited<ReturnType<typeof floorOf>>;

// Who edited or deleted a floor: its anonymous author stays anonymous.
async function doer(trx: Transaction<DB>, f: Floor, userId: number) {
  return userId === f.author_id ? f.author : person(trx, userId);
}

function qqText(f: Floor) {
  return `【${f.board_name}】${f.title}\n${f.author.display_name}：${excerpt(f.html, QQ_EXCERPT)}\n${link(f.thread_id, f.floor)}`;
}

export async function threadCreated(trx: Transaction<DB>, openingPostId: number) {
  const f = await floorOf(trx, openingPostId);
  await recordEvent(trx, "thread.created", {
    thread: { id: f.thread_id, title: f.title, kind: f.kind },
    board: { slug: f.board_slug, name: f.board_name },
    author: f.author,
    source: f.source,
    url: link(f.thread_id, 1),
    qq_text: qqText(f),
  });
}

// With the floor it answers, so the plugin can quote that floor's QQ message when it passes the
// reply back to the group.
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
      source: target.source,
    },
    source: f.source,
    url: link(f.thread_id, f.floor),
    qq_text: qqText(f),
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
    qq_text: `【${f.board_name}】${f.title}\n已采纳 ${f.author.display_name} 的回答：${excerpt(f.html, QQ_EXCERPT)}\n${link(f.thread_id, f.floor)}`,
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
