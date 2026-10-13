import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/topic-floors.ts";

// Floors before or after the ones a topic page has loaded: ?after=N or ?before=N.
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const query = new URL(request.url).searchParams;
  const res = await context.get(apiContext).threads[":id"].posts.$get({
    param: { id: params.id },
    query: { after: query.get("after") ?? undefined, before: query.get("before") ?? undefined },
  });
  if (!res.ok) throw data("主题不存在", { status: 404 });
  return (await res.json()).items;
}
