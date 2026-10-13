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
      reactRouterHonoServer({ serverEntryPoint: "server/main.ts" }),
      tailwindcss(),
      reactRouter(),
      babel({ include: /\/app\/.+\.tsx?$/, plugins: ["babel-plugin-react-compiler"] }),
    ],
    resolve: { tsconfigPaths: true },
  };
});
