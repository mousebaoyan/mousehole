import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/topic-post.ts";

// A floor shown in another's preview when it isn't on the page: the one replied to.
export async function loader({ params, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).posts[":id"].$get({
    param: { id: params.post },
    query: {},
  });
  if (!res.ok) throw data("回复不存在", { status: 404 });
  return res.json();
}
