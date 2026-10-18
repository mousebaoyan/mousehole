import { sql, type ExpressionBuilder } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { BOUNTY_DAYS } from "../coins/rules.ts";

// Bounties (design §8.19): questions and 保研定位 asked on the forum that nobody else answered for
// a day, in boards all members read. The coins are settled with the others (coins module).

const LASTS = sql`make_interval(days => ${BOUNTY_DAYS})`;

// Nobody but its author has replied, as far as anyone can see.
function unanswered(eb: ExpressionBuilder<DB, "threads">) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom("posts")
        .select("posts.id")
        .whereRef("posts.thread_id", "=", "threads.id")
        .whereRef("posts.author_id", "<>", "threads.author_id")
        .where("posts.floor", ">", 1)
        .where("posts.status", "=", "visible")
        .where("posts.deleted_at", "is", null),
    ),
  );
}

function open() {
  return db
    .selectFrom("threads")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .where("threads.deleted_at", "is", null)
    .where("threads.status", "=", "visible")
    .where("boards.read_level", "=", 0)
    .where(unanswered);
}

// Hourly: those asked over a day and under three days ago, once each. Asked on the forum: the
// opening post isn't archived from a group.
export async function startBounties() {
  const due = open()
    .select("threads.id")
    .where("threads.bounty_at", "is", null)
    .where("threads.locked", "=", false)
    .where("threads.created_at", "<", sql<Date>`now() - interval '1 day'`)
    .where("threads.created_at", ">", sql<Date>`now() - ${LASTS}`)
    .where((eb) =>
      eb.or([
        eb("threads.kind", "=", "question"),
        eb.exists(
          eb
            .selectFrom("polls")
            .select("polls.thread_id")
            .whereRef("polls.thread_id", "=", "threads.id")
            .where("polls.preset", "=", "positioning"),
        ),
      ]),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("posts")
            .select("posts.id")
            .whereRef("posts.thread_id", "=", "threads.id")
            .where("posts.floor", "=", 1)
            .where("posts.via", "=", "qq"),
        ),
      ),
    );
  await db
    .updateTable("threads")
    .set({ bounty_at: sql<Date>`now()` })
    .where("id", "in", due)
    .execute();
}

// For the bot plugin to tell the groups: those put up in [since, until) still unanswered, the
// first first.
export async function listBounties(since: Date, until: Date) {
  const rows = await open()
    .select([
      "threads.id",
      "threads.title",
      "threads.kind",
      "boards.slug",
      "boards.name",
      sql<Date>`threads.bounty_at + ${LASTS}`.as("until"),
    ])
    .where("threads.bounty_at", ">=", since)
    .where("threads.bounty_at", "<", until)
    .orderBy("threads.bounty_at")
    .execute();
  return rows.map((r) => ({
    thread: { id: r.id, title: r.title, kind: r.kind },
    board: { slug: r.slug, name: r.name },
    url: `${env.PUBLIC_URL}/t/${r.id}`,
    until: r.until,
  }));
}
