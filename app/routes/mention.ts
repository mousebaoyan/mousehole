import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/mention.ts";

// Members for the editor's @ suggestions.
export async function loader({ request, context }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const res = await context.get(apiContext).users.$get({ query: { q } });
  return res.ok ? (await res.json()).items : [];
}
