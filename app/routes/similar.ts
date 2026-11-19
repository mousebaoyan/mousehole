import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/similar.ts";

// Threads like the one being written, for the composer (design §8.5): only what it lists of them.
export async function loader({ request, context }: Route.LoaderArgs) {
  const text = new URL(request.url).searchParams.get("text") ?? "";
  const res = await context.get(apiContext).search.similar.$get({ query: { text } });
  return (await res.json()).items.map(({ thread }) => ({
    id: thread.id,
    title: thread.title,
    reply_count: thread.reply_count,
    solved: thread.solved,
  }));
}
