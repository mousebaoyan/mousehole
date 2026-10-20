import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import type { Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import { userBriefs } from "../users/service.ts";

// The poll under a poll thread's opening post; see design §8.11. Written with the thread, and
// fixed from then on but for votes and closing.

export type PollSpec =
  | {
      preset?: undefined;
      options: string[];
      // Rows each rated with the options, one choice a row; null for a plain poll.
      rows: string[] | null;
      multiple: boolean;
      // For a multiple choice, at most this many; null for any.
      max_choices: number | null;
      anonymous: boolean;
      results: "voted" | "always";
      // Unix seconds; null for never.
      closes_at: number | null;
    }
  // 保研定位 (design §8.14): the poster names the schools, the forum sets the rest.
  | { preset: "positioning"; rows: string[] };

// How hard each school would be, easiest first; then 不清楚 for a voter who can't tell, which
// counts as having voted but not toward the school's results.
const POSITIONING_GRADES = ["随便去", "努把力", "看运气", "有点难", "几乎不可能"];
const UNSURE = "不清楚";

export async function createPoll(trx: Transaction<DB>, threadId: number, spec: PollSpec) {
  const poll =
    spec.preset === "positioning"
      ? {
          ...spec,
          options: [...POSITIONING_GRADES, UNSURE],
          multiple: false,
          max_choices: null,
          anonymous: true,
          results: "voted" as const,
          closes_at: null,
        }
      : { ...spec, preset: null };
  await trx
    .insertInto("polls")
    .values({
      thread_id: threadId,
      multiple: poll.multiple,
      max_choices: poll.multiple ? poll.max_choices : null,
      anonymous: poll.anonymous,
      results: poll.results,
      closes_at: poll.closes_at === null ? null : new Date(poll.closes_at * 1000),
      rows: poll.rows,
      preset: poll.preset,
    })
    .execute();
  await trx
    .insertInto("poll_options")
    .values(
      (poll.rows ?? [""]).flatMap((_, row) =>
        poll.options.map((label, position) => ({ thread_id: threadId, row, position, label })),
      ),
    )
    .execute();
}

function isClosed(poll: { closes_at: Date | null; closed_at: Date | null }) {
  return poll.closed_at !== null || (poll.closes_at !== null && poll.closes_at <= new Date());
}

// What a reader sees of it. The counts wait until they voted or the poll closed, unless the
// author chose to show them all along; how many voted shows anyway.
export async function getPoll(threadId: number, viewerId: number | null) {
  const [poll, options, mine] = await Promise.all([
    db.selectFrom("polls").selectAll().where("thread_id", "=", threadId).executeTakeFirstOrThrow(),
    db
      .selectFrom("poll_options")
      .select(["id", "row", "position", "label", "vote_count"])
      .where("thread_id", "=", threadId)
      .orderBy("row")
      .orderBy("position")
      .execute(),
    viewerId === null
      ? []
      : db
          .selectFrom("poll_votes")
          .select("option_id")
          .where("thread_id", "=", threadId)
          .where("user_id", "=", viewerId)
          .execute(),
  ]);
  const closed = isClosed(poll);
  const shown = poll.results === "always" || closed || mine.length > 0;
  return {
    multiple: poll.multiple,
    max_choices: poll.max_choices,
    anonymous: poll.anonymous,
    results: poll.results,
    rows: poll.rows,
    preset: poll.preset,
    closes_at: poll.closes_at,
    closed,
    voter_count: poll.voter_count,
    options: options.map((o) => ({
      id: o.id,
      row: o.row,
      label: o.label,
      votes: shown ? o.vote_count : null,
      abstain: poll.preset === "positioning" && o.position === POSITIONING_GRADES.length,
    })),
    my_votes: viewerId === null ? null : mine.map((v) => v.option_id),
  };
}

export type Poll = Awaited<ReturnType<typeof getPoll>>;

function invalid(message: string) {
  return new AppError(400, "invalid_request", message);
}

// The thread as the reader opened it, already checked for whether they may see it.
type Opened = { id: number; author_id: number; status: string; locked: boolean };

function pollNotFound() {
  return new AppError(404, "poll_not_found", "这个帖子没有投票");
}

// Replaces the voter's choices; none takes their vote back. The poll's row is locked, so the
// counts move one vote at a time.
export async function vote(actor: Actor, thread: Opened, optionIds: number[]) {
  if (thread.status !== "visible") {
    throw new AppError(403, "forbidden", "帖子待审核或已隐藏，暂时不能投票");
  }
  if (thread.locked) throw new AppError(403, "thread_locked", "帖子已锁定");
  const chosen = [...new Set(optionIds)];
  await db.transaction().execute(async (trx) => {
    const poll = await trx
      .selectFrom("polls")
      .selectAll()
      .where("thread_id", "=", thread.id)
      .forUpdate()
      .executeTakeFirst();
    if (!poll) throw pollNotFound();
    if (isClosed(poll)) throw new AppError(403, "poll_closed", "投票已结束");
    if (!poll.multiple && poll.rows === null && chosen.length > 1) {
      throw invalid("此投票为单选，只能选择一项");
    }
    if (poll.max_choices !== null && chosen.length > poll.max_choices) {
      throw invalid(`最多选 ${poll.max_choices} 项`);
    }
    if (chosen.length > 0) {
      const found = await trx
        .selectFrom("poll_options")
        .select("row")
        .where("thread_id", "=", thread.id)
        .where("id", "in", chosen)
        .execute();
      if (found.length !== chosen.length) throw invalid("选项不属于此投票");
      if (poll.rows !== null && new Set(found.map((o) => o.row)).size !== found.length) {
        throw invalid("每行只能选择一项");
      }
    }

    const removed = await trx
      .deleteFrom("poll_votes")
      .where("thread_id", "=", thread.id)
      .where("user_id", "=", actor.userId)
      .returning("option_id")
      .execute();
    if (removed.length > 0) {
      await trx
        .updateTable("poll_options")
        .set((eb) => ({ vote_count: eb("vote_count", "-", 1) }))
        .where(
          "id",
          "in",
          removed.map((r) => r.option_id),
        )
        .execute();
    }
    if (chosen.length > 0) {
      await trx
        .insertInto("poll_votes")
        .values(
          chosen.map((option_id) => ({ option_id, user_id: actor.userId, thread_id: thread.id })),
        )
        .execute();
      await trx
        .updateTable("poll_options")
        .set((eb) => ({ vote_count: eb("vote_count", "+", 1) }))
        .where("id", "in", chosen)
        .execute();
    }
    const voters = Number(chosen.length > 0) - Number(removed.length > 0);
    if (voters !== 0) {
      await trx
        .updateTable("polls")
        .set((eb) => ({ voter_count: eb("voter_count", "+", voters) }))
        .where("thread_id", "=", thread.id)
        .execute();
    }
    await recordAudit(trx, actor, {
      action: "poll.vote",
      target_type: "thread",
      target_id: thread.id,
      data: { options: chosen },
    });
  });
}

// Before its time, by the author or a moderator; closing one that is over changes nothing.
export async function closePoll(actor: Actor, moderator: boolean, thread: Opened) {
  if (thread.author_id !== actor.userId && !moderator) {
    throw new AppError(403, "forbidden", "只有楼主和版主能结束投票");
  }
  await db.transaction().execute(async (trx) => {
    const poll = await trx
      .selectFrom("polls")
      .select(["closes_at", "closed_at"])
      .where("thread_id", "=", thread.id)
      .forUpdate()
      .executeTakeFirst();
    if (!poll) throw pollNotFound();
    if (isClosed(poll)) return;
    await trx
      .updateTable("polls")
      .set({ closed_at: sql<Date>`now()` })
      .where("thread_id", "=", thread.id)
      .execute();
    await recordAudit(trx, actor, {
      action: "poll.close",
      target_type: "thread",
      target_id: thread.id,
    });
  });
}

// Who chose an option, for a poll that isn't anonymous, once its counts show to the reader.
export async function listVoters(poll: Poll | null, optionId: number) {
  if (!poll) throw pollNotFound();
  if (poll.anonymous) throw new AppError(403, "forbidden", "匿名投票不公开投票人");
  const option = poll.options.find((o) => o.id === optionId);
  if (!option) throw new AppError(404, "option_not_found", "选项不存在");
  if (option.votes === null) throw new AppError(403, "forbidden", "投票后或投票结束后才能查看");
  const rows = await db
    .selectFrom("poll_votes")
    .select("user_id")
    .where("option_id", "=", optionId)
    .orderBy("created_at")
    .execute();
  const user = await userBriefs(rows.map((r) => r.user_id));
  return rows.map((r) => user(r.user_id));
}

// For the bot plugin's evening digest in the groups (design §8.6): polls put up in [since, until)
// that can still be voted on, in boards all members read, the first first. Each comes up in one
// digest only, as the plugin asks from where it left off.
export async function listNewPolls(since: Date, until: Date) {
  const rows = await db
    .selectFrom("polls")
    .innerJoin("threads", "threads.id", "polls.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .select(["threads.id", "threads.title", "polls.voter_count"])
    .where("threads.created_at", ">=", since)
    .where("threads.created_at", "<", until)
    .where("threads.deleted_at", "is", null)
    .where("threads.status", "=", "visible")
    .where("threads.locked", "=", false)
    .where("boards.read_level", "=", 0)
    .where("polls.closed_at", "is", null)
    .where((eb) =>
      eb.or([eb("polls.closes_at", "is", null), eb("polls.closes_at", ">", sql<Date>`now()`)]),
    )
    .orderBy("threads.created_at")
    .execute();
  return rows.map((r) => ({
    thread: { id: r.id, title: r.title },
    voters: r.voter_count,
    url: `${env.PUBLIC_URL}/t/${r.id}`,
  }));
}
