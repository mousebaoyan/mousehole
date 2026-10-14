import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/user-card.ts";

// What the profile card shows, fetched when it opens.
export async function loader({ params, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).users[":user"].$get({ param: { user: params.id } });
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  return res.json();
}
