import type { InferResponseType } from "hono/client";
import type { createApi } from "./api.server.ts";

// What pages get from /api/v1, for components shared between routes.
export type Api = ReturnType<typeof createApi>;

export type ThreadDetail = InferResponseType<Api["threads"][":id"]["$get"], 200>;
export type ThreadItem = InferResponseType<Api["threads"]["$get"], 200>["items"][number];
export type PostItem = InferResponseType<
  Api["threads"][":id"]["posts"]["$get"],
  200
>["items"][number];
export type UserBrief = PostItem["author"];
