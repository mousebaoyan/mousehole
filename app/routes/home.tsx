import { ThreadFeed } from "~/components/thread-feed";
import { threads } from "~/draft-data";
import type { Route } from "./+types/home.ts";

export function meta() {
  return [{ title: "鼠洞 · 四非计算机保研鼠群的论坛" }];
}

export function loader({ request }: Route.LoaderArgs) {
  const sort = new URL(request.url).searchParams.get("sort") ?? "latest";
  const list =
    sort === "unsolved"
      ? threads.filter((t) => t.kind === "question" && !t.solved)
      : sort === "hot"
        ? threads.toSorted((a, b) => b.views - a.views)
        : threads;
  return { sort, threads: list };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return <ThreadFeed threads={loaderData.threads} sort={loaderData.sort} />;
}
