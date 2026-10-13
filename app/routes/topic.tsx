import {
  Bell,
  Bookmark,
  CircleCheck,
  Eye,
  Link2,
  MessageSquare,
  MessagesSquare,
  Reply,
} from "lucide-react";
import { useEffect, useState } from "react";
import { data } from "react-router";
import { BoardBadge } from "~/components/board-badge";
import { useComposer } from "~/components/composer";
import { ThreadList } from "~/components/thread-list";
import { Button } from "~/components/ui/button";
import { boards, checkInPosts, threads, topicPosts } from "~/draft-data";
import { useMe } from "~/me";
import type { Route } from "./+types/topic.ts";
import { FloorNav, FloorProgress } from "./floor-timeline.tsx";
import { PostCard } from "./post-card.tsx";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData.thread.title} · 鼠洞` }];
}

export function loader({ params }: Route.LoaderArgs) {
  const thread = threads.find((t) => t.id === Number(params.id));
  const board = boards.find((b) => b.slug === thread?.board);
  if (!thread || !board) throw data("主题不存在", { status: 404 });
  return {
    thread,
    board,
    posts: thread.id === 8 ? checkInPosts : topicPosts,
    // From thread_users.read_floors once reading is recorded.
    readFloors: [1, 2, 3],
    suggested: threads.filter((t) => t.id !== thread.id && !t.pinned).slice(0, 5),
  };
}

export default function Topic({
  loaderData: { thread, board, posts, readFloors, suggested },
}: Route.ComponentProps) {
  const me = useMe();
  const read = useReadFloors(me !== null, readFloors);
  const openComposer = useComposer();
  const target = { id: thread.id, title: thread.title };

  return (
    <div className="flex gap-8">
      <article className="min-w-0 flex-1">
        <header className="px-1 pb-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
            <BoardBadge board={board} />
            {thread.tags.map((t) => (
              <span key={t}>#{t}</span>
            ))}
          </div>
          <h1 className="mt-2.5 text-xl leading-snug font-semibold tracking-tight sm:text-2xl">
            {thread.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground tabular-nums">
            {thread.kind === "question" && thread.solved && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">
                <CircleCheck className="size-3.5" /> 已解决
              </span>
            )}
            {thread.fromQQ && (
              <span className="inline-flex items-center gap-1" title="由群聊转入">
                <MessagesSquare className="size-3.5" /> 群聊
              </span>
            )}
            <span className="inline-flex items-center gap-1" title="浏览">
              <Eye className="size-3.5" /> {thread.views.toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1" title="回复">
              <MessageSquare className="size-3.5" /> {thread.replies}
            </span>
          </div>
        </header>

        <ol className="flex flex-col">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              op={post.author.id === thread.author.id}
              parent={posts.find((p) => p.floor === post.replyTo)}
              replies={posts.filter((p) => p.replyTo === post.floor)}
              unread={me ? !read.has(post.floor) : undefined}
              onReply={() =>
                openComposer({
                  thread: target,
                  replyTo: { floor: post.floor, name: post.author.name },
                })
              }
            />
          ))}
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

        <section className="mt-12">
          <h2 className="px-3 font-semibold sm:px-4">推荐主题</h2>
          <div className="mt-3">
            <ThreadList threads={suggested} />
          </div>
        </section>
      </article>

      <aside className="hidden w-56 shrink-0 xl:block">
        <nav aria-label="楼层" className="sticky top-20 rounded-2xl border bg-card p-3 text-meta">
          <FloorNav posts={posts} />
        </nav>
      </aside>
      <FloorProgress posts={posts} />
    </div>
  );
}

const TICK_MS = 500;
// On screen this long, a floor counts as read and its dot fades.
const READ_MS = 2000;
// The sticky header covers the top of the window.
const HEADER_PX = 64;

// Ticks like Discourse's screen tracker, adding up how long each floor has been on screen while
// the page is in front. The real page also sends what was read in batches; see design §8.9.
function useReadFloors(tracked: boolean, initial: number[]) {
  const [read, setRead] = useState(() => new Set(initial));
  useEffect(() => {
    if (!tracked) return undefined;
    const shownMs = new Map<number, number>();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const done: number[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("[data-floor]")) {
        const { top, bottom } = el.getBoundingClientRect();
        const shown = Math.min(bottom, innerHeight) - Math.max(top, HEADER_PX);
        // Half of the floor, or half of the window for a floor taller than that.
        if (shown < Math.min(bottom - top, innerHeight - HEADER_PX) / 2) continue;
        const floor = Number(el.dataset.floor);
        const ms = (shownMs.get(floor) ?? 0) + TICK_MS;
        shownMs.set(floor, ms);
        if (ms >= READ_MS) done.push(floor);
      }
      setRead((r) => (done.every((f) => r.has(f)) ? r : new Set([...r, ...done])));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [tracked]);
  return read;
}
