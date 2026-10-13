import { Kysely, PostgresDialect } from "kysely";
import { Pool, types } from "pg";
import type { DB } from "../../db/types.ts";
import { env } from "./env.ts";

// QQ numbers and bigint ids stay far below 2^53, so int8 is safe as a JS number.
types.setTypeParser(types.builtins.INT8, Number);

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
// Idle connections break when PostgreSQL restarts. pg drops them from the pool,
// but crashes the process if nobody listens for the error.
pool.on("error", (error) => console.error(error));

export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
