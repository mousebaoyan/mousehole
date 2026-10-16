import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import type { Actor } from "../../platform/access.ts";
import { AppError } from "../../platform/errors.ts";

// QQ messages in one chat: a group, or a private chat with someone. A floor archived from a
// group is organized from one or more of them (plugin design §8).
export type Source = { chat_type: "group" | "private"; chat_id: number; message_ids: number[] };

// Content archived from a group is dated when it was said there, which the bot gives; never
// later than now (design §6.5).
export function postedAt(actor: Actor, createdAt: number | undefined) {
  if (createdAt === undefined) return sql<Date>`now()`;
  if (actor.tokenId === null) {
    throw new AppError(403, "forbidden", "只有 bot 收录群聊时能带 created_at");
  }
  return sql<Date>`least(to_timestamp(${createdAt}), now())`;
}

type Message = { chat_type: "group" | "private"; chat_id: number; message_id: number };

function sourceExists(link: { thread_id: number; post_id: number }) {
  return new AppError(409, "source_exists", "这条 QQ 消息已收录到论坛", {
    details: { thread_id: link.thread_id, post_id: link.post_id },
  });
}

export async function findLink(message: Message) {
  return db
    .selectFrom("qq_message_links")
    .select(["thread_id", "post_id"])
    .where("chat_type", "=", message.chat_type)
    .where("chat_id", "=", message.chat_id)
    .where("message_id", "=", message.message_id)
    .executeTakeFirst();
}

// Floors the messages already belong to, other than the one being written.
function linkedElsewhere(executor: Kysely<DB>, source: Source, postId: number | null) {
  return executor
    .selectFrom("qq_message_links")
    .select(["thread_id", "post_id"])
    .where("chat_type", "=", source.chat_type)
    .where("chat_id", "=", source.chat_id)
    .where("message_id", "in", source.message_ids)
    .where("post_id", "is distinct from", postId);
}

// Refused early, before any images are fetched for nothing.
export async function assertNotLinked(source: Source, postId: number | null) {
  const link = await linkedElsewhere(db, source, postId).executeTakeFirst();
  if (link) throw sourceExists(link);
}

// The messages a floor came from, in the transaction that posts or edits it; they replace what
// it had. A message belongs to one floor only.
export async function linkSource(
  trx: Transaction<DB>,
  source: Source,
  threadId: number,
  postId: number,
) {
  await trx.deleteFrom("qq_message_links").where("post_id", "=", postId).execute();
  const linked = await trx
    .insertInto("qq_message_links")
    .values(
      source.message_ids.map((message_id) => ({
        chat_type: source.chat_type,
        chat_id: source.chat_id,
        message_id,
        thread_id: threadId,
        post_id: postId,
      })),
    )
    .onConflict((oc) => oc.columns(["chat_type", "chat_id", "message_id"]).doNothing())
    .returning("message_id")
    .execute();
  if (linked.length < source.message_ids.length) {
    throw sourceExists(await linkedElsewhere(trx, source, postId).executeTakeFirstOrThrow());
  }
}
