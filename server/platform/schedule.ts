import type { Expression, Transaction } from "kysely";
import type { DB } from "../../db/types.ts";
import { log } from "./log.ts";

// Jobs that run every so often inside this one process. A failed run is logged and the next one
// tries again. A run still going when the next is due skips that one, so a long run (avatars for
// a newly synced group) isn't joined by a second doing the same work.
export function every(ms: number, name: string, job: () => Promise<unknown>) {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch((error: unknown) => log("error", `${name} failed`, { error }))
      .finally(() => {
        running = false;
      });
  }, ms).unref();
}

// How far a job that mustn't repeat, or must know where it left off, got: in the transaction of
// the work it records.
export async function recordRun(
  trx: Transaction<DB>,
  name: string,
  ranAt: Date | Expression<Date>,
) {
  await trx
    .insertInto("job_runs")
    .values({ name, ran_at: ranAt })
    .onConflict((oc) => oc.column("name").doUpdateSet({ ran_at: ranAt }))
    .execute();
}
