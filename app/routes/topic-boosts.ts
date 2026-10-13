import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/topic-boosts.ts";

// All of a floor's boosts, for when there are more than the floor came with.
export async function loader({ params, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).posts[":id"].boosts.$get({
    param: { id: params.post },
  });
  if (!res.ok) throw data("回复不存在", { status: 404 });
  return res.json();
}
