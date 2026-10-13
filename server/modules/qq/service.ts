import type { Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";

// A QQ message: in a group, or in a private chat with someone.
export type Source = { chat_type: "group" | "private"; chat_id: number; message_id: number };

function sourceExists(link: { thread_id: number; post_id: number | null }) {
  return new AppError(409, "source_exists", "这条 QQ 消息已经转到论坛了", {
    details: { thread_id: link.thread_id, post_id: link.post_id },
  });
}

export async function findLink(source: Source) {
  return db
    .selectFrom("qq_message_links")
    .select(["kind", "thread_id", "post_id"])
    .where("chat_type", "=", source.chat_type)
    .where("chat_id", "=", source.chat_id)
    .where("message_id", "=", source.message_id)
    .executeTakeFirst();
}

// Refused early, before any images are fetched for nothing.
export async function assertNotLinked(source: Source) {
  const link = await findLink(source);
  if (link) throw sourceExists(link);
}

// The message content came from, in the transaction that posts it.
export async function linkSource(
  trx: Transaction<DB>,
  source: Source,
  threadId: number,
  postId: number,
) {
  const linked = await trx
    .insertInto("qq_message_links")
    .values({ ...source, kind: "source", thread_id: threadId, post_id: postId })
    .onConflict((oc) => oc.columns(["chat_type", "chat_id", "message_id"]).doNothing())
    .returning("thread_id")
    .executeTakeFirst();
  if (!linked) {
    const link = await trx
      .selectFrom("qq_message_links")
      .select(["thread_id", "post_id"])
      .where("chat_type", "=", source.chat_type)
      .where("chat_id", "=", source.chat_id)
      .where("message_id", "=", source.message_id)
      .executeTakeFirstOrThrow();
    throw sourceExists(link);
  }
}

// A bot's message telling the group about a thread or a floor. Sending it again for the same
// message replaces the target; a message that is some content's source stays that.
export async function linkNotice(source: Source, threadId: number, postId: number | null) {
  const linked = await db
    .insertInto("qq_message_links")
    .values({ ...source, kind: "notice", thread_id: threadId, post_id: postId })
    .onConflict((oc) =>
      oc
        .columns(["chat_type", "chat_id", "message_id"])
        .doUpdateSet({ thread_id: threadId, post_id: postId })
        .where("qq_message_links.kind", "=", "notice"),
    )
    .returning("thread_id")
    .executeTakeFirst();
  if (!linked) throw new AppError(409, "source_exists", "这条 QQ 消息是论坛内容的来源");
}
