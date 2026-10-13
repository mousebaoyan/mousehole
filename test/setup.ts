import { randomUUID } from "node:crypto";
import { adminQuery, databaseUrl, TEMPLATE } from "./database.ts";

// Each test file gets its own database, so files can run in parallel.
const name = `${TEMPLATE}_${randomUUID().replaceAll("-", "")}`;
await adminQuery(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
process.env.DATABASE_URL = databaseUrl(name);
