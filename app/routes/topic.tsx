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
import { data } from "react-router";
import { BoardBadge } from "~/components/board-badge";
import { useComposer } from "~/components/composer";
import { ThreadRow } from "~/components/thread-row";
import { Button } from "~/components/ui/button";
import { boards, checkInPosts, threads, topicPosts } from "~/draft-data";
import type { Route } from "./+types/topic.ts";
import { FloorNav } from "./floor-timeline.tsx";
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
    suggested: threads.filter((t) => t.id !== thread.id && !t.pinned).slice(0, 5),
  };
}

export default function Topic({
  loaderData: { thread, board, posts, suggested },
}: Route.ComponentProps) {
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
              onReply={() =>
                openComposer({
                  thread: target,
                  replyTo: { floor: post.floor, name: post.author.name },
                })
              }
            />
          ))}
        </ol>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-5 sm:pl-[4.25rem]">
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
          <h2 className="px-1 font-semibold">推荐主题</h2>
          <ul className="mt-2">
            {suggested.map((t) => (
              <ThreadRow key={t.id} thread={t} />
            ))}
          </ul>
        </section>
      </article>

      <aside className="hidden w-56 shrink-0 xl:block">
        <nav aria-label="楼层" className="sticky top-20 rounded-2xl border bg-card p-3 text-meta">
          <FloorNav posts={posts} />
        </nav>
      </aside>
    </div>
  );
}
