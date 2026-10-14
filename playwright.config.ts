import { defineConfig, devices } from "@playwright/test";
import { BASE, SERVER_ENV } from "./e2e/env.ts";

// The few key flows in a real browser (docs/development.md §5), against the built forum;
// `pnpm e2e` builds it first.
export default defineConfig({
  testDir: "e2e",
  use: { ...devices["Desktop Chrome"], baseURL: BASE },
  webServer: {
    command: "node e2e/database.ts && node build/server/index.js",
    url: `${BASE}/healthz`,
    env: SERVER_ENV,
  },
});
