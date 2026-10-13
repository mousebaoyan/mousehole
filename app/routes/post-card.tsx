import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Ellipsis,
  Flag,
  Forward,
  Link2,
  MessagesSquare,
  Reply,
  Rocket,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { useFetcher } from "react-router";
import { cn } from "cn";
import { Dropdown, menuItem, useDismiss } from "~/components/disclosure";
import { EmojiButton } from "~/components/emoji-button";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { Button, buttonVariants } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import type { PostItem, UserBrief } from "~/api-types";
import { useMe } from "~/forum";
import { stamp } from "~/time";
import { LikeButton, ReactionSummary, useReaction } from "./reactions.tsx";

// Shared by posts and the previews of the posts they reply to or that reply to them.
const PROSE =
  "prose prose-neutral mt-2 max-w-none text-body leading-7 dark:prose-invert prose-p:my-2 prose-a:font-normal prose-a:text-link prose-a:no-underline hover:prose-a:underline prose-blockquote:border-brand/50 prose-blockquote:font-normal prose-blockquote:text-muted-foreground prose-blockquote:not-italic prose-code:before:content-none prose-code:after:content-none prose-pre:bg-secondary prose-pre:text-foreground prose-li:my-0.5 [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none";

// Busy posts can collect dozens of boosts; past this many they fold behind a counter.
const BOOSTS_SHOWN = 6;

const BOOST_MAX = 16;

// Counts what people see as characters, so an emoji is one.
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

const reportReasons = ["垃圾广告", "人身攻击", "违法违规", "其他"];

// `parent` is the floor this one replies to when it is on the page; otherwise it is fetched when
// the reader opens it. The floors that reply to this one are fetched the same way.
export function PostCard({
  post,
  threadId,
  op,
  accepted,
  now,
  parent,
  onReply,
  onJump,
}: {
  post: PostItem;
  threadId: number;
  op: boolean;
  accepted: boolean;
  now: number;
  parent: PostItem | undefined;
  onReply: () => void;
  onJump: (floor: number) => void;
}) {
  const [allBoosts, setAllBoosts] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const parentFetcher = useFetcher<PostItem>();
  const repliesFetcher = useFetcher<PostItem[]>();
  const report = useRef<HTMLDialogElement>(null);
  // Reactions and boosts are kept on this page until their API exists.
  const reaction = useReaction({}, undefined);
  const boosts: { user: UserBrief; text: string }[] = [];
  const shownBoosts = allBoosts ? boosts : boosts.slice(0, BOOSTS_SHOWN);
  const replyTo = post.reply_to;
  const target = parent ?? parentFetcher.data;

  if (post.deleted) {
    return (
      <li
        id={`floor-${post.floor}`}
        data-floor={post.floor}
        className="relative scroll-mt-20 px-3 py-4 text-meta text-muted-foreground sm:px-4"
      >
        <span className="tabular-nums">#{post.floor}</span> 该楼已删除
      </li>
    );
  }

  return (
    <li
      id={`floor-${post.floor}`}
      data-floor={post.floor}
      className={cn(
        // A faint rule above each post, starting under the name like the body does.
        "relative scroll-mt-20 px-3 py-5 before:absolute before:top-0 before:right-3 before:left-3 before:h-px before:bg-border/70 first:before:hidden sm:px-4 sm:before:right-4 sm:before:left-[4.25rem]",
        accepted &&
          "my-2 rounded-2xl border border-success/30 bg-success/[0.04] before:hidden [&+li]:before:hidden",
      )}
    >
      {accepted && (
        <div className="mb-3 inline-flex items-center gap-1 text-meta font-medium text-success">
          <CircleCheck className="size-4" /> 已采纳
        </div>
      )}
      <div className="flex items-center gap-3">
        <UserAvatar user={post.author} className="size-10 max-sm:size-9" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="mr-0.5 text-body font-semibold">{post.author.display_name}</span>
          <UserBadges user={post.author} op={op} />
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {post.via === "qq" && (
              <MessagesSquare className="size-3.5" aria-label="来自群聊">
                <title>来自群聊</title>
              </MessagesSquare>
            )}
            {replyTo && (
              <button
                type="button"
                aria-expanded={parentOpen}
                title={`回复 #${replyTo.floor}，点开查看`}
                onClick={() => {
                  if (!target && parentFetcher.state === "idle") {
                    void parentFetcher.load(`/t/${threadId}/p/${replyTo.id}`);
                  }
                  setParentOpen(!parentOpen);
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1 hover:bg-accent hover:text-foreground",
                  parentOpen && "bg-accent text-foreground",
                )}
              >
                <Forward className="size-3.5" />
                <UserAvatar user={replyTo.author} className="size-5 text-2xs" />
                {replyTo.author.display_name}
              </button>
            )}
            {stamp(post.created_at, now)}
            <a
              href={`?floor=${post.floor}`}
              className="-m-1.5 p-1.5 tabular-nums hover:text-foreground"
            >
              #{post.floor}
            </a>
          </span>
        </div>
      </div>

      {/* Indented under the name on wider screens; full width on phones. */}
      <div className="sm:pl-[3.25rem]">
        {replyTo && parentOpen && (
          <div className="mt-3 rounded-xl border-l-2 border-border bg-secondary/40 px-3 py-1">
            {target ? (
              <PostPreview post={target} jump="up" onJump={onJump} />
            ) : (
              <p className="py-3 text-meta text-muted-foreground">加载中…</p>
            )}
          </div>
        )}
        <div className={cn(PROSE, "mt-2")} dangerouslySetInnerHTML={{ __html: post.html ?? "" }} />

        {/* Relative: the boost input floats from this row when there are no boosts yet. */}
        <div className="relative mt-4 flex flex-wrap items-center gap-x-1 gap-y-2">
          <ReactionSummary sorted={reaction.sorted} />
          {post.reply_count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={repliesOpen}
              onClick={() => {
                if (!repliesFetcher.data && repliesFetcher.state === "idle") {
                  void repliesFetcher.load(`/t/${threadId}/p/${post.id}/replies`);
                }
                setRepliesOpen(!repliesOpen);
              }}
              className={cn("text-muted-foreground", repliesOpen && "bg-accent text-foreground")}
            >
              {post.reply_count} 个回复 {repliesOpen ? <ChevronUp /> : <ChevronDown />}
            </Button>
          )}
          {boosts.length === 0 && (
            <div className="text-muted-foreground">
              <BoostButton />
            </div>
          )}
          <div className="ml-auto flex items-center text-muted-foreground">
            <LikeButton mine={reaction.mine} onChange={reaction.setMine} />
            <Button variant="ghost" size="icon-sm" aria-label="复制链接" title="复制链接">
              <Link2 />
            </Button>
            <Dropdown
              label="更多"
              triggerClassName={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              trigger={<Ellipsis />}
            >
              {(close) => (
                <>
                  <button type="button" className={menuItem} onClick={close}>
                    <Bookmark /> 收藏
                  </button>
                  <button
                    type="button"
                    className={menuItem}
                    onClick={() => {
                      close();
                      report.current?.showModal();
                    }}
                  >
                    <Flag /> 举报
                  </button>
                </>
              )}
            </Dropdown>
            <Button variant="ghost" size="sm" onClick={onReply}>
              <Reply /> 回复
            </Button>
          </div>
        </div>

        {/* Boosts, with the rocket at the end; the boost input floats from this row. */}
        {boosts.length > 0 && (
          <ul className="relative mt-2 flex flex-wrap items-center gap-1.5">
            {shownBoosts.map((b) => (
              <li
                key={b.user.id}
                title={b.user.display_name}
                className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-2.5 pl-0.5 text-meta"
              >
                <UserAvatar user={b.user} className="size-5 text-2xs" />
                {b.text}
              </li>
            ))}
            {!allBoosts && boosts.length > BOOSTS_SHOWN && (
              <li>
                <button
                  type="button"
                  onClick={() => setAllBoosts(true)}
                  className="h-6 rounded-full px-2 text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  +{boosts.length - BOOSTS_SHOWN}
                </button>
              </li>
            )}
            <li className="text-muted-foreground">
              <BoostButton />
            </li>
          </ul>
        )}

        {repliesOpen && (
          // A rule down the avatars ties the replies to this floor.
          <ol className="relative mt-3 before:absolute before:top-4 before:bottom-8 before:left-[1.125rem] before:w-0.5 before:rounded-full before:bg-border">
            {repliesFetcher.data ? (
              repliesFetcher.data.map((r) => (
                <li key={r.id}>
                  <PostPreview post={r} jump="down" onJump={onJump} />
                </li>
              ))
            ) : (
              <li className="py-3 pl-12 text-meta text-muted-foreground">加载中…</li>
            )}
          </ol>
        )}
      </div>

      <ReportDialog ref={report} floor={post.floor} />
    </li>
  );
}

// A compact copy of another floor, with a way to jump to where it sits in the thread.
function PostPreview({
  post,
  jump,
  onJump,
}: {
  post: PostItem;
  jump: "up" | "down";
  onJump: (floor: number) => void;
}) {
  const Arrow = jump === "up" ? ArrowUp : ArrowDown;
  return (
    <div className="relative flex gap-3 py-3">
      <UserAvatar user={post.author} className="size-9 ring-4 ring-background" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="text-sm font-semibold">{post.author.display_name}</span>
          <UserBadges user={post.author} />
          <a
            href={`?floor=${post.floor}`}
            onClick={(e) => {
              e.preventDefault();
              onJump(post.floor);
            }}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Arrow className="size-3.5" /> 跳到 #{post.floor}
          </a>
        </div>
        {post.deleted ? (
          <p className="mt-1 text-meta text-muted-foreground">该楼已删除</p>
        ) : (
          <div
            className={cn(PROSE, "mt-1")}
            dangerouslySetInnerHTML={{ __html: post.html ?? "" }}
          />
        )}
      </div>
    </div>
  );
}

// Floats over the content below instead of pushing it down, like linux.do's. It is placed
// against the action row rather than the button, so it fits on narrow screens.
function BoostButton() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const me = useMe();
  useDismiss(open, () => setOpen(false), root);
  const length = [...graphemes.segment(text)].length;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  return (
    <div ref={root}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="短评"
        title="短评"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Rocket />
      </Button>
      {open && (
        <form
          className="absolute top-full left-0 z-30 mt-2 flex w-[min(24rem,100%)] items-center gap-1 rounded-full border bg-popover py-1 pr-1 pl-1.5 shadow-lg animate-in fade-in zoom-in-95"
          onSubmit={(e) => {
            e.preventDefault();
            setText("");
            setOpen(false);
          }}
        >
          {me && <UserAvatar user={me} className="size-7" />}
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="短评"
            placeholder="短评…"
            className="min-w-0 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          {length > BOOST_MAX - 4 && (
            <span
              className={cn(
                "text-xs tabular-nums",
                length > BOOST_MAX ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {length}/{BOOST_MAX}
            </span>
          )}
          <EmojiButton target={input} onChange={setText} side="bottom" />
          <Button
            type="submit"
            size="icon-sm"
            className="rounded-full"
            aria-label="发送"
            disabled={length === 0 || length > BOOST_MAX}
          >
            <Check />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            aria-label="取消"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </form>
      )}
    </div>
  );
}

// A native <dialog>: modal, Esc to close and focus handling come with the browser.
function ReportDialog({ ref, floor }: { ref: Ref<HTMLDialogElement>; floor: number }) {
  return (
    <dialog
      ref={ref}
      className="m-auto w-[min(24rem,calc(100%-2rem))] rounded-2xl border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/30"
    >
      <form method="dialog">
        <h2 className="font-semibold">举报 #{floor}</h2>
        <fieldset className="mt-4 grid grid-cols-2 gap-2">
          {reportReasons.map((reason) => (
            <label
              key={reason}
              className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-checked:border-brand has-checked:bg-brand/10"
            >
              <input type="radio" name="reason" value={reason} className="accent-brand" />
              {reason}
            </label>
          ))}
        </fieldset>
        <Textarea placeholder="补充说明（选填）" className="mt-3 min-h-20" />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="submit" variant="ghost" value="cancel">
            取消
          </Button>
          <Button type="submit">提交</Button>
        </div>
      </form>
    </dialog>
  );
}
