import { reactRouter } from "@react-router/dev/vite";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { reactRouterHonoServer } from "react-router-hono-server/dev";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Server code reads process.env, but Vite only loads .env into import.meta.env.
  Object.assign(process.env, loadEnv(mode, import.meta.dirname, ""));

  return {
    plugins: [
      reactRouterHonoServer({
        serverEntryPoint: "server/main.ts",
        // Pages import constants shared with the server, such as the site's name and the
        // notification types; in development the browser loads them as modules, which otherwise
        // only files under app/ may be.
        dev: { exclude: [/^\/server\/.+\.ts(\?.*)?$/] },
      }),
      tailwindcss(),
      reactRouter(),
      babel({ include: /\/app\/.+\.tsx?$/, plugins: ["babel-plugin-react-compiler"] }),
    ],
    resolve: { tsconfigPaths: true },
    // The browsers in `browserslist` (package.json), named Vite's way, so it rewrites the syntax
    // they lack; its default starts at iOS 16.4.
    environments: {
      client: { build: { target: ["ios15.4", "safari15.4", "chrome100", "firefox128"] } },
    },
  };
});
