# Built by GitHub Actions and pulled by the server, which never compiles; see design §12.
FROM node:26-slim AS base
WORKDIR /app
RUN npm install --global pnpm@12.8.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
# The install copies the emoji data into public/, from where the build serves it.
COPY scripts/copy-emoji-data.ts scripts/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/build build
COPY package.json ./
# Migrations run at start-up; the server source is for `node scripts/bootstrap.ts`.
COPY db db
COPY server server
COPY scripts/bootstrap.ts scripts/
RUN mkdir data && chown node:node data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--max-old-space-size=192", "build/server/index.js"]
