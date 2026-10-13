import { Outlet } from "react-router";
import { apiContext } from "../api.server.ts";
import { ForumNav } from "~/components/forum-nav";
import { SiteHeader } from "~/components/site-header";
import type { Route } from "./+types/forum-layout.ts";

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).me.$get();
  return { me: res.ok ? await res.json() : null };
}

export default function ForumLayout({ loaderData: { me } }: Route.ComponentProps) {
  return (
    <>
      <SiteHeader me={me} />
      <div className="mx-auto flex max-w-[1280px] gap-8 px-2 sm:px-5">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-52 shrink-0 overflow-y-auto py-6 lg:block">
          <ForumNav />
        </aside>
        <div className="min-w-0 flex-1 pt-4 pb-16 sm:pt-6">
          <Outlet />
        </div>
      </div>
    </>
  );
}
