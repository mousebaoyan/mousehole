import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/topic-replies.ts";

// The floors that reply to one, shown under it: ?after=N for the next batch.
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).posts[":id"].replies.$get({
    param: { id: params.post },
    query: { after: new URL(request.url).searchParams.get("after") ?? undefined },
  });
  if (!res.ok) throw data("回复不存在", { status: 404 });
  return (await res.json()).items;
}
