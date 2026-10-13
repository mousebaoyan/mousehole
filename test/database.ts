import { Client } from "pg";
import { z } from "zod";

export const TEMPLATE = "mousehole_test";

// Same server as DATABASE_URL, different database.
export function databaseUrl(name: string) {
  const url = new URL(z.url().parse(process.env.DATABASE_URL));
  url.pathname = `/${name}`;
  return url.href;
}

export async function adminQuery(text: string) {
  const client = new Client({ connectionString: databaseUrl("postgres") });
  await client.connect();
  try {
    return (await client.query<{ datname: string }>(text)).rows;
  } finally {
    await client.end();
  }
}

export async function dropTestDatabases() {
  const rows = await adminQuery(
    `SELECT datname FROM pg_database WHERE datname LIKE '${TEMPLATE}%'`,
  );
  for (const { datname } of rows) await adminQuery(`DROP DATABASE "${datname}" WITH (FORCE)`);
}
