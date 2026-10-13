import { adminQuery, databaseUrl, dropTestDatabases, TEMPLATE } from "./database.ts";

// Migrate a template once; test/setup.ts copies it for each test file.
export async function setup() {
  await dropTestDatabases();
  await adminQuery(`CREATE DATABASE ${TEMPLATE}`);
  process.env.DATABASE_URL = databaseUrl(TEMPLATE);
  const { migrate } = await import("../server/platform/migrate.ts");
  const { db } = await import("../server/platform/db.ts");
  await migrate();
  await db.destroy();
}

export const teardown = dropTestDatabases;
