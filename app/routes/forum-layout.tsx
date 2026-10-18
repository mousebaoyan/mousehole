import { Outlet, type ShouldRevalidateFunctionArgs } from "react-router";
import { apiContext } from "../api.server.ts";
import { ComposerProvider } from "~/components/composer";
import { ForumNav } from "~/components/forum-nav";
import { PageTransition } from "~/components/page-transition";
import { SiteHeader } from "~/components/site-header";
import type { Route } from "./+types/forum-layout.ts";

export async function loader({ context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const [me, boards, tags, unread, site, drafts] = await Promise.all([
    api.me.$get(),
    api.boards.$get(),
    api.tags.$get(),
    api.notifications["unread-count"].$get(),
    api.site.$get(),
    api.me.drafts.$get(),
  ]);
  return {
    banner: (await site.json()).banner,
    me: me.ok ? await me.json() : null,
    unread: unread.ok ? (await unread.json()).count : 0,
    boards: (await boards.json()).items,
    tags: (await tags.json()).items,
    // Which drafts there are, for the composer and the sidebar.
    drafts: drafts.ok ? (await drafts.json()).items.map((d) => ({ thread: d.thread })) : [],
  };
}

// The reader, boards and tags don't change with the page or its filters, only after a submission
// or when a page asks to load again (useRevalidator), which keeps the address.
export function shouldRevalidate({
  formMethod,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return defaultShouldRevalidate && (formMethod !== undefined || currentUrl.href === nextUrl.href);
}

export default function ForumLayout({
  loaderData: { me, unread, banner, drafts },
}: Route.ComponentProps) {
  return (
    <ComposerProvider drafts={drafts}>
      <SiteHeader me={me} unread={unread} />
      {banner && (
        <p className="bg-brand/10 px-4 py-2 text-center text-meta text-brand-strong">{banner}</p>
      )}
      <div className="mx-auto flex max-w-7xl gap-8 px-2 sm:px-5">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-52 shrink-0 overflow-y-auto py-6 [scrollbar-width:none] lg:block">
          <ForumNav />
        </aside>
        <div className="min-w-0 flex-1 pt-4 pb-16 sm:pt-6">
          <PageTransition>
            <Outlet />
          </PageTransition>
        </div>
      </div>
    </ComposerProvider>
  );
}
