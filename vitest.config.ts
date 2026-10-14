import { loadEnv } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

Object.assign(process.env, loadEnv("test", import.meta.dirname, ""));

export default defineConfig({
  test: {
    globalSetup: "test/global-setup.ts",
    setupFiles: "test/setup.ts",
    // The browser tests run with Playwright.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
