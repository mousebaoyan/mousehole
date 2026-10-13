import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/topic-post.ts";

// A floor shown in another's preview when it isn't on the page, or its Markdown for editing
// (?body=markdown).
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const markdown = new URL(request.url).searchParams.get("body") === "markdown";
  const res = await context.get(apiContext).posts[":id"].$get({
    param: { id: params.post },
    query: { body: markdown ? "markdown" : "html" },
  });
  if (!res.ok) throw data("回复不存在", { status: 404 });
  return res.json();
}
