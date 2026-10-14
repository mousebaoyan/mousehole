import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/thread-reactions.ts";

// Who reacted to a floor, for the list under its reaction counts.
export async function loader({ params, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).posts[":id"].reactions.$get({
    param: { id: params.post },
    query: {},
  });
  if (!res.ok) throw data("回复不存在", { status: 404 });
  return res.json();
}
