import { CircleCheck, Ellipsis, Eye, Link2, MessagesSquare, Reply, SmilePlus } from "lucide-react";
import { data } from "react-router";
import { cn } from "cn";
import { BoardBadge } from "~/components/board-badge";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { boards, threads, topicPosts, type Post } from "~/draft-data";
import type { Route } from "./+types/topic.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData.thread.title} · 鼠洞` }];
}

export function loader({ params }: Route.LoaderArgs) {
  const thread = threads.find((t) => t.id === Number(params.id));
  const board = boards.find((b) => b.slug === thread?.board);
  if (!thread || !board) throw data("主题不存在", { status: 404 });
  return { thread, board, posts: topicPosts };
}

export default function Topic({ loaderData: { thread, board, posts } }: Route.ComponentProps) {
  return (
    <div className="flex gap-8">
      <article className="min-w-0 flex-1">
        <header className="px-1 pb-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            <BoardBadge board={board} />
            {thread.tags.map((t) => (
              <span key={t}>#{t}</span>
            ))}
          </div>
          <h1 className="mt-2 text-[22px] leading-snug font-semibold tracking-tight sm:text-2xl">
            {thread.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            {thread.kind === "question" && thread.solved && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">
                <CircleCheck className="size-3.5" /> 已解决
              </span>
            )}
            {thread.fromQQ && (
              <span className="inline-flex items-center gap-1">
                <MessagesSquare className="size-3.5" /> 从群聊转来
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Eye className="size-3.5" /> {thread.views} 次浏览
            </span>
            <span>{thread.replies} 条回复</span>
          </div>
        </header>

        <ol className="flex flex-col gap-3">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} op={post.author.id === thread.author.id} />
          ))}
        </ol>

        <form className="mt-6 rounded-2xl border p-3 focus-within:ring-2 focus-within:ring-ring/30">
          <Textarea
            placeholder="写下你的回复，支持 Markdown，可以直接粘贴图片"
            className="min-h-24 resize-y border-0 p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">草稿会自动保存在这台设备上</span>
            <Button type="button">回复</Button>
          </div>
        </form>
      </article>

      <aside className="hidden w-60 shrink-0 xl:block">
        <div className="sticky top-20 flex flex-col gap-4 text-[13px]">
          <section className="rounded-2xl border p-4">
            <h2 className="font-semibold">楼层</h2>
            <p className="mt-1 text-muted-foreground">共 {posts.length} 层，被采纳的答案在 2 楼</p>
            <div className="mt-3 flex flex-col gap-0.5">
              {posts.map((p) => (
                <a
                  key={p.id}
                  href={`#floor-${p.floor}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
                >
                  <span className="w-6 text-muted-foreground tabular-nums">#{p.floor}</span>
                  <span className="truncate">{p.author.name}</span>
                  {p.accepted && <CircleCheck className="ml-auto size-3.5 text-success" />}
                </a>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function PostCard({ post, op }: { post: Post; op: boolean }) {
  return (
    <li
      id={`floor-${post.floor}`}
      className={cn(
        "scroll-mt-20 rounded-2xl border border-transparent px-3 py-4 sm:px-4",
        post.accepted && "border-success/30 bg-success/[0.04]",
      )}
    >
      {post.accepted && (
        <div className="mb-3 inline-flex items-center gap-1 text-[13px] font-medium text-success">
          <CircleCheck className="size-4" /> 楼主采纳了这个回答
        </div>
      )}
      <div className="flex items-center gap-3">
        <UserAvatar user={post.author} className="size-10 max-sm:size-9" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="mr-0.5 text-[15px] font-semibold">{post.author.name}</span>
          <UserBadges user={post.author} op={op} />
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {post.fromQQ && (
              <span className="inline-flex items-center gap-1">
                <MessagesSquare className="size-3.5" /> 来自群聊
              </span>
            )}
            {post.time}
            <a href={`#floor-${post.floor}`} className="tabular-nums hover:text-foreground">
              #{post.floor}
            </a>
          </span>
        </div>
      </div>

      {/* Indented under the name on wider screens; full width on phones. */}
      <div className="sm:pl-[3.25rem]">
        <div
          className="prose prose-neutral mt-2 max-w-none text-[15px] leading-7 dark:prose-invert prose-p:my-2 prose-a:font-normal prose-a:text-link prose-a:no-underline hover:prose-a:underline prose-blockquote:font-normal prose-blockquote:text-muted-foreground prose-blockquote:not-italic prose-code:before:content-none prose-code:after:content-none prose-pre:bg-secondary prose-pre:text-foreground prose-li:my-0.5 [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none"
          dangerouslySetInnerHTML={{ __html: post.html }}
        />

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {post.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[13px] tabular-nums hover:bg-accent",
                r.mine && "border-link/40 bg-link/10 text-link",
              )}
            >
              <span>{r.emoji}</span>
              {r.count}
            </button>
          ))}
          <Button variant="ghost" size="icon-sm" aria-label="表情回应">
            <SmilePlus />
          </Button>
          <div className="ml-auto flex items-center text-muted-foreground">
            <Button variant="ghost" size="sm">
              <Reply /> 回复
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="复制链接">
              <Link2 />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="更多">
              <Ellipsis />
            </Button>
          </div>
        </div>

        {post.replies && (
          <div className="mt-3 rounded-xl bg-secondary/60 px-3 py-2">
            {post.replies.map((r) => (
              <div key={r.id} className="flex gap-2 py-1.5 text-[14px] leading-relaxed">
                <UserAvatar user={r.author} className="mt-0.5 size-6" />
                <p className="min-w-0 flex-1">
                  <span className="font-medium">{r.author.name}</span>
                  {r.replyTo && (
                    <span className="text-muted-foreground"> 回复 {r.replyTo.name}</span>
                  )}
                  <span className="text-muted-foreground">：</span>
                  {r.text}
                  <span className="ml-2 text-xs text-muted-foreground">{r.time}</span>
                </p>
              </div>
            ))}
            {post.moreReplies && (
              <button type="button" className="py-1.5 pl-8 text-[13px] text-link hover:underline">
                查看另外 {post.moreReplies} 条回复
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
