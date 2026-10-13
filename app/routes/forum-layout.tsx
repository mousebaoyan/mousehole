import { Outlet, type ShouldRevalidateFunctionArgs } from "react-router";
import { apiContext } from "../api.server.ts";
import { ComposerProvider } from "~/components/composer";
import { ForumNav } from "~/components/forum-nav";
import { SiteHeader } from "~/components/site-header";
import type { Route } from "./+types/forum-layout.ts";

export async function loader({ context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const [me, boards, tags] = await Promise.all([api.me.$get(), api.boards.$get(), api.tags.$get()]);
  return {
    me: me.ok ? await me.json() : null,
    boards: (await boards.json()).items,
    tags: (await tags.json()).items,
  };
}

// The reader, boards and tags don't change with the page or its filters, only after a submission.
export function shouldRevalidate({
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return formMethod !== undefined && defaultShouldRevalidate;
}

export default function ForumLayout({ loaderData: { me } }: Route.ComponentProps) {
  return (
    <ComposerProvider>
      <SiteHeader me={me} />
      <div className="mx-auto flex max-w-7xl gap-8 px-2 sm:px-5">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-52 shrink-0 overflow-y-auto py-6 lg:block">
          <ForumNav />
        </aside>
        <div className="min-w-0 flex-1 pt-4 pb-16 sm:pt-6">
          <Outlet />
        </div>
      </div>
    </ComposerProvider>
  );
}
