import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
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
      source.message_ids.map((message_id, position) => ({
        chat_type: source.chat_type,
        chat_id: source.chat_id,
        message_id,
        position,
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

// A thread's floors merged into another (design §8.20) take their messages along: quoting one in
// the group carries on in the thread they are in now.
export async function moveLinks(trx: Transaction<DB>, threadId: number, intoId: number) {
  await trx
    .updateTable("qq_message_links")
    .set({ thread_id: intoId })
    .where("thread_id", "=", threadId)
    .execute();
}

// Answers written on the forum to questions archived from a group, for the plugin to tell each
// asker in the group (design §8.6): only boards every member reads, and not anonymous threads,
// whose askers it would name. Askers who left the groups or have read every one aren't told.
export async function newAnswers(since: Date, until: Date) {
  const { rows } = await sql<{
    id: number;
    title: string;
    created_at: number;
    asker_id: number;
    display_name: string;
    qq: number;
    chat_id: number;
    message_id: number;
    count: number;
    floor: number;
  }>`SELECT t.id, t.title, extract(epoch FROM t.created_at)::integer AS created_at,
      u.id AS asker_id, u.display_name, u.qq, l.chat_id, l.message_id,
      count(*)::integer AS count, min(p.floor) AS floor
    FROM posts p
    JOIN threads t ON t.id = p.thread_id
    JOIN boards b ON b.id = t.board_id
    JOIN posts o ON o.thread_id = t.id AND o.floor = 1
    JOIN qq_message_links l ON l.post_id = o.id AND l.position = 0
    JOIN users u ON u.id = t.author_id
    LEFT JOIN thread_users tu ON tu.thread_id = t.id AND tu.user_id = t.author_id
    WHERE t.kind = 'question' AND NOT t.author_anonymous
      AND t.status = 'visible' AND t.deleted_at IS NULL
      AND (b.visibility = 'public' OR b.read_level = 0)
      AND l.chat_type = 'group' AND u.member_status = 'member'
      AND p.floor > 1 AND p.status = 'visible' AND p.deleted_at IS NULL
      AND p.via <> 'qq' AND p.author_id <> t.author_id
      AND p.created_at >= ${since} AND p.created_at < ${until}
    GROUP BY t.id, u.id, l.chat_id, l.message_id
    HAVING NOT bool_and(coalesce(tu.read_floors @> p.floor, false))
    ORDER BY count DESC, t.id`.execute(db);
  return rows.map((r) => ({
    thread: { id: r.id, title: r.title, created_at: r.created_at },
    asker: { id: r.asker_id, display_name: r.display_name, qq: r.qq },
    source: { chat_id: r.chat_id, message_id: r.message_id },
    count: r.count,
    url: `${env.PUBLIC_URL}/t/${r.id}?floor=${r.floor}`,
  }));
}
