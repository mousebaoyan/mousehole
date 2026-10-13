import { ThreadFeed } from "~/components/thread-feed";
import { listThreads, readFilter } from "~/draft-data";
import type { Route } from "./+types/home.ts";

export function meta() {
  return [{ title: "鼠洞 · 四非计算机保研鼠群的论坛" }];
}

export function loader({ request }: Route.LoaderArgs) {
  const filter = readFilter(request.url);
  return { ...filter, ...listThreads(null, filter.tag, filter.view) };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return <ThreadFeed {...loaderData} board={null} />;
}
