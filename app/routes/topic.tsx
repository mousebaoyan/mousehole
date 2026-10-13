import {
  AtSign,
  Bold,
  CircleCheck,
  Code,
  Eye,
  ImagePlus,
  Link2,
  MessageSquare,
  MessagesSquare,
  Quote,
} from "lucide-react";
import { data } from "react-router";
import { BoardBadge } from "~/components/board-badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
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
  return { thread, board, posts: thread.id === 8 ? checkInPosts : topicPosts };
}

const tools = [
  { label: "粗体", icon: Bold },
  { label: "引用", icon: Quote },
  { label: "代码", icon: Code },
  { label: "链接", icon: Link2 },
  { label: "图片", icon: ImagePlus },
  { label: "提及", icon: AtSign },
];

export default function Topic({ loaderData: { thread, board, posts } }: Route.ComponentProps) {
  return (
    <div className="flex gap-8">
      <article className="min-w-0 flex-1">
        <header className="px-1 pb-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
            <BoardBadge board={board} />
            {thread.tags.map((t) => (
              <span key={t}>#{t}</span>
            ))}
          </div>
          <h1 className="mt-2 text-xl leading-snug font-semibold tracking-tight sm:text-2xl">
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

        <ol className="flex flex-col gap-3">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} op={post.author.id === thread.author.id} />
          ))}
        </ol>

        <form className="mt-6 rounded-2xl border bg-card focus-within:ring-2 focus-within:ring-ring/30">
          <div className="flex items-center gap-0.5 border-b px-2 py-1 text-muted-foreground">
            {tools.map((t) => (
              <Button
                key={t.label}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t.label}
                title={t.label}
              >
                <t.icon />
              </Button>
            ))}
          </div>
          <Textarea
            aria-label="回复内容"
            className="min-h-28 resize-y border-0 px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex justify-end px-3 pb-3">
            <Button type="button">回复</Button>
          </div>
        </form>
      </article>

      <aside className="hidden w-56 shrink-0 xl:block">
        <nav aria-label="楼层" className="sticky top-20 text-meta">
          <FloorNav posts={posts} />
        </nav>
      </aside>
    </div>
  );
}
