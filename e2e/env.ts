import { existsSync } from "node:fs";
import { z } from "zod";

// The browser tests' server: the built forum on a port and database of its own, so the tests
// never touch local data. Both the server and the bootstrap command run with this environment.
if (existsSync(".env")) process.loadEnvFile(".env");
const database = new URL(z.url().parse(process.env.DATABASE_URL));
database.pathname = "/mousehole_e2e";

export const BASE = "http://localhost:3300";

export const SERVER_ENV = {
  DATABASE_URL: database.href,
  PUBLIC_URL: BASE,
  PORT: "3300",
  NODE_ENV: "production",
};
