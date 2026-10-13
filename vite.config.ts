import { reactRouter } from "@react-router/dev/vite";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { reactRouterHonoServer } from "react-router-hono-server/dev";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    reactRouterHonoServer({ serverEntryPoint: "server/main.ts" }),
    tailwindcss(),
    reactRouter(),
    babel({ include: /\/app\/.+\.tsx?$/, plugins: ["babel-plugin-react-compiler"] }),
  ],
  resolve: { tsconfigPaths: true },
});
