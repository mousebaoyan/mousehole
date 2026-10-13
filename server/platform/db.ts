import { Kysely, PostgresDialect } from "kysely";
import { Client, Pool, types } from "pg";
import type { DB } from "../../db/types.ts";
import { env } from "./env.ts";
import { log } from "./log.ts";

// QQ numbers and bigint ids stay far below 2^53, so int8 is safe as a JS number.
types.setTypeParser(types.builtins.INT8, Number);

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
// Idle connections break when PostgreSQL restarts. pg drops them from the pool,
// but crashes the process if nobody listens for the error.
pool.on("error", (error) => log("error", "Idle database connection failed", { error }));

export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

function listenFailed(error: unknown) {
  log("warn", "LISTEN connection failed", { error });
}

// A connection of its own, outside the pool, waiting for NOTIFY on `channel`. Lost, it connects
// again a second later, then calls `onNotify` once for whatever came in between.
export function listen(channel: string, onNotify: () => void) {
  async function connect() {
    const client = new Client({ connectionString: env.DATABASE_URL });
    client.on("error", listenFailed);
    try {
      await client.connect();
    } catch (error) {
      listenFailed(error);
      setTimeout(() => void connect(), 1000);
      return;
    }
    client.on("notification", onNotify);
    client.on("end", () => setTimeout(() => void connect(), 1000));
    // A failure here ends the connection as well, so it connects again.
    await client.query(`LISTEN ${channel}`).then(onNotify, listenFailed);
  }
  void connect();
}
