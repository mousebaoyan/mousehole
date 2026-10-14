import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/thread-voters.ts";

// Who chose an option of a poll, for the list under its count.
export async function loader({ params, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).threads[":id"].poll.options[":option"].voters.$get({
    param: { id: params.id, option: params.option },
  });
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  return { items: (await res.json()).items.map((user) => ({ user, note: null })) };
}
