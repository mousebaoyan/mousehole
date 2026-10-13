import { Bell, Bookmark, CircleCheck, Eye, Link2, MessageSquare, Reply } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { data, redirect, useFetcher, useNavigate } from "react-router";
import { apiContext } from "../api.server.ts";
import type { PostItem } from "~/api-types";
import { BoardBadge } from "~/components/board-badge";
import { useComposer } from "~/components/composer";
import { ThreadList } from "~/components/thread-list";
import { Button } from "~/components/ui/button";
import { useMe } from "~/forum";
import { useNearView } from "~/near-view";
import { stamp, unixNow } from "~/time";
import type { Route } from "./+types/topic.ts";
import { FloorNav, FloorProgress, useCurrentFloor, type Floors } from "./floor-timeline.tsx";
import { PostCard } from "./post-card.tsx";

// Floors come 20 at a time; see design §9.
const BATCH = 20;

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData.thread.title} · 鼠洞` }];
}

// The page opens at ?floor=N, or the opening post, and shows the 20 floors from there. Near the
// end it takes the floors before too, so it doesn't open on a lone floor.
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const start = Math.max(
    1,
    Math.trunc(Number(new URL(request.url).searchParams.get("floor")) || 1),
  );
  const param = { id: params.id };
  const [threadRes, afterRes, latestRes] = await Promise.all([
    api.threads[":id"].$get({ param }),
    api.threads[":id"].posts.$get({ param, query: { after: String(start - 1) } }),
    api.threads.$get({ query: {} }),
  ]);
  if (!threadRes.ok || !afterRes.ok) throw data("主题不存在", { status: 404 });
  const thread = await threadRes.json();
  const after = (await afterRes.json()).items;
  let posts = after;
  if (after.length < BATCH && start > 1) {
    const beforeRes = await api.threads[":id"].posts.$get({
      param,
      query: { before: String(after.at(0)?.floor ?? start) },
    });
    if (beforeRes.ok) posts = [...(await beforeRes.json()).items, ...after];
  }
  const latest = latestRes.ok ? (await latestRes.json()).items : [];
  return {
    thread,
    posts,
    start: after.at(0)?.floor ?? posts.at(-1)?.floor ?? 1,
    moreAfter: after.length === BATCH,
    suggested: latest.filter((t) => t.id !== thread.id && t.pinned === 0).slice(0, 5),
    now: unixNow(),
  };
}

// Changes to the floors on this page. They answer with the floor to show next, so the page can
// open there with fresh data; a deleted thread leaves for its board.
export async function action({ params, request, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const form = await request.formData();
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const post = { id: text("post_id") };
  const floor = Number(text("floor"));
  if (text("intent") === "delete-thread") {
    const res = await api.threads[":id"].$delete({ param: { id: params.id } });
    if (res.ok) return redirect(`/b/${text("board")}`);
    return { ok: false as const, message: (await res.json()).error.message };
  }
  const res =
    text("intent") === "delete-post"
      ? await api.posts[":id"].$delete({ param: post })
      : await api.posts[":id"].$patch({
          param: post,
          json: { content: { markdown: text("markdown") } },
        });
  if (res.ok) return { ok: true as const, floor };
  return { ok: false as const, message: (await res.json()).error.message };
}

export default function Topic({ loaderData }: Route.ComponentProps) {
  // Each load starts afresh: a jump to a floor that isn't on the page, or a change to one.
  return (
    <TopicPage
      key={`${loaderData.thread.id}:${loaderData.start}:${loaderData.now}`}
      {...loaderData}
    />
  );
}

function TopicPage({
  thread,
  posts: initial,
  start,
  moreAfter,
  suggested,
  now,
}: Route.ComponentProps["loaderData"]) {
  const openComposer = useComposer();
  const navigate = useNavigate();
  const me = useMe();
  const staff = me?.role === "moderator" || me?.role === "admin";
  // Deletions: the page then reopens at the floor, with the change in it.
  const changes = useFetcher<typeof action>();
  useEffect(() => {
    if (changes.state !== "idle" || !changes.data) return;
    if (changes.data.ok) void navigate(`?floor=${changes.data.floor}`, { replace: true });
    else alert(changes.data.message);
  }, [changes.state, changes.data, navigate]);
  const later = useFetcher<PostItem[]>();
  const earlier = useFetcher<PostItem[]>();
  const [loaded, setLoaded] = useState({
    posts: initial,
    atEnd: !moreAfter,
    later: later.data,
    earlier: earlier.data,
  });
  // Floors fetched as the reader scrolls join the ones on the page, as soon as they arrive.
  if (later.data !== loaded.later || earlier.data !== loaded.earlier) {
    let { posts, atEnd } = loaded;
    if (later.data && later.data !== loaded.later) {
      const tail = posts.at(-1)?.floor ?? 0;
      posts = [...posts, ...later.data.filter((p) => p.floor > tail)];
      atEnd = later.data.length < BATCH;
    }
    if (earlier.data && earlier.data !== loaded.earlier) {
      const head = posts.at(0)?.floor ?? Infinity;
      posts = [...earlier.data.filter((p) => p.floor < head), ...posts];
    }
    setLoaded({ posts, atEnd, later: later.data, earlier: earlier.data });
  }
  const { posts, atEnd } = loaded;
  const top = useRef<HTMLLIElement>(null);
  const bottom = useRef<HTMLLIElement>(null);
  const first = posts.at(0)?.floor ?? 1;
  const last = posts.at(-1)?.floor ?? 0;

  // Before the current floor is measured, so it is measured from here.
  useLayoutEffect(() => {
    if (start > 1) document.getElementById(`floor-${start}`)?.scrollIntoView();
  }, [start]);
  const [current, setCurrent] = useCurrentFloor(start);

  // The address follows the floor being read, so a refresh, a shared link or Back returns to it.
  // Replaced directly: a router navigation would load the page again.
  useEffect(() => {
    const url = new URL(location.href);
    if (current > 1) url.searchParams.set("floor", String(current));
    else url.searchParams.delete("floor");
    history.replaceState(history.state, "", url);
  }, [current]);

  useNearView(bottom, !atEnd && later.state === "idle", () => {
    void later.load(`/t/${thread.id}/floors?after=${last}`);
  });
  useNearView(top, first > 1 && earlier.state === "idle", () => {
    void earlier.load(`/t/${thread.id}/floors?before=${first}`);
  });

  // Floors put above keep what was being read in place: the first floor that was on the page is
  // moved back to where it was. Done here rather than by the browser's scroll anchoring, which
  // Safari, and so QQ on iPhones, doesn't have. Offsets are from the top of the document, so
  // scrolling while the floors load doesn't matter.
  const firstOffset = useRef<{ floor: number; offset: number } | null>(null);
  useLayoutEffect(() => {
    const before = firstOffset.current;
    const old = before && document.getElementById(`floor-${before.floor}`);
    if (before && old && first < before.floor) scrollBy(0, documentTop(old) - before.offset);
    const element = document.getElementById(`floor-${first}`);
    firstOffset.current = element && { floor: first, offset: documentTop(element) };
  }, [first]);

  function jump(floor: number) {
    const element = document.getElementById(`floor-${floor}`);
    if (element) {
      element.scrollIntoView();
      setCurrent(floor);
    } else {
      void navigate(`?floor=${floor}`, { preventScrollReset: true });
    }
  }

  const target = { id: thread.id, title: thread.title };
  const floors: Floors = {
    posts,
    total: thread.floor_count,
    current,
    jump,
    first: stamp(thread.created_at, now),
    last: stamp(thread.last_post_at, now),
    now,
    solvedPostId: thread.solved_post_id,
  };

  return (
    <div className="flex gap-8">
      <article className="min-w-0 flex-1">
        <header className="px-1 pb-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
            <BoardBadge board={thread.board} />
            {thread.tags.map((t) => (
              <span key={t}>#{t}</span>
            ))}
          </div>
          <h1 className="mt-2.5 text-xl leading-snug font-semibold tracking-tight sm:text-2xl">
            {thread.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground tabular-nums">
            {thread.solved_post_id !== null && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">
                <CircleCheck className="size-3.5" /> 已解决
              </span>
            )}
            <span className="inline-flex items-center gap-1" title="浏览">
              <Eye className="size-3.5" /> {thread.view_count.toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1" title="回复">
              <MessageSquare className="size-3.5" /> {thread.reply_count}
            </span>
          </div>
        </header>

        {/* No browser scroll anchoring: floors put above are compensated for by hand. */}
        <ol className="flex flex-col [overflow-anchor:none]">
          {first > 1 && (
            <li ref={top} className="py-3 text-center text-meta">
              <a
                href={`?floor=${Math.max(1, first - BATCH)}`}
                className="text-muted-foreground hover:text-foreground"
              >
                {earlier.state === "loading" ? "加载中…" : `前 ${Math.min(first - 1, BATCH)} 层`}
              </a>
            </li>
          )}
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              threadId={thread.id}
              op={post.author.id === thread.author.id}
              accepted={post.id === thread.solved_post_id}
              now={now}
              parent={posts.find((p) => p.id === post.reply_to?.id)}
              manage={{
                change: staff || (me?.id === post.author.id && !thread.locked),
                history: staff || me?.id === post.author.id,
                deleteThread:
                  staff ||
                  (me?.id === post.author.id && !thread.locked && thread.reply_count === 0),
              }}
              onJump={jump}
              onEdit={(markdown) =>
                openComposer({
                  thread: target,
                  replyTo: null,
                  edit: { postId: post.id, floor: post.floor, markdown },
                })
              }
              onDelete={() => {
                const question = post.floor === 1 ? "删除这个主题？" : `删除 #${post.floor}？`;
                if (!confirm(question)) return;
                void changes.submit(
                  post.floor === 1
                    ? { intent: "delete-thread", board: thread.board.slug }
                    : { intent: "delete-post", post_id: post.id, floor: post.floor },
                  { method: "post", defaultShouldRevalidate: false },
                );
              }}
              onReply={() =>
                openComposer({
                  thread: target,
                  replyTo: { id: post.id, floor: post.floor, name: post.author.display_name },
                })
              }
            />
          ))}
          {!atEnd && (
            <li ref={bottom} className="py-3 text-center text-meta">
              <a
                href={`?floor=${last + 1}`}
                className="text-muted-foreground hover:text-foreground"
              >
                {later.state === "loading" ? "加载中…" : "后 20 层"}
              </a>
            </li>
          )}
        </ol>

        {/* Lined up with the avatars above. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t px-3 pt-5 sm:px-4">
          <Button size="lg" onClick={() => openComposer({ thread: target, replyTo: null })}>
            <Reply /> 回复
          </Button>
          <Button size="lg" variant="outline">
            <Bookmark /> 收藏
          </Button>
          <Button size="lg" variant="outline">
            <Bell /> 关注
          </Button>
          <Button size="icon-lg" variant="ghost" aria-label="复制链接" title="复制链接">
            <Link2 />
          </Button>
        </div>

        {suggested.length > 0 && (
          <section className="mt-12">
            <h2 className="px-3 font-semibold sm:px-4">推荐主题</h2>
            <div className="mt-3">
              <ThreadList threads={suggested} now={now} />
            </div>
          </section>
        )}
      </article>

      <aside className="hidden w-56 shrink-0 xl:block">
        <nav aria-label="楼层" className="sticky top-20 rounded-2xl border bg-card p-3 text-meta">
          <FloorNav floors={floors} />
        </nav>
      </aside>
      <FloorProgress floors={floors} />
    </div>
  );
}

function documentTop(element: HTMLElement) {
  return element.getBoundingClientRect().top + scrollY;
}
