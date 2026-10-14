import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/thread-revisions.ts";

// A floor's edit history, for its author and moderators.
export async function loader({ params, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).posts[":id"].revisions.$get({
    param: { id: params.post },
  });
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  return (await res.json()).items;
}
