import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/user-card.ts";

// What the profile card shows, fetched when it opens. Returned rather than thrown when missing,
// so a deleted account's card says so instead of the page turning into an error.
export async function loader({ params, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).users[":user"].$get({ param: { user: params.id } });
  if (!res.ok) return data(null, { status: 404 });
  return res.json();
}
