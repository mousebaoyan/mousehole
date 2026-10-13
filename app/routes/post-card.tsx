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
import { useRouteLoaderData } from "react-router";
import { cn } from "cn";
import { Dropdown, menuItem, useDismiss } from "~/components/disclosure";
import { EmojiButton } from "~/components/emoji-button";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { Button, buttonVariants } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import type { Post } from "~/draft-data";
import type { loader as forumLoader } from "./forum-layout.tsx";
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

// `parent` is the post this one replies to; `replies` are the posts that reply to this one.
// `unread` is left out for guests, whose reading isn't tracked.
export function PostCard({
  post,
  op,
  parent,
  replies,
  unread,
  onReply,
}: {
  post: Post;
  op: boolean;
  parent: Post | undefined;
  replies: Post[];
  unread?: boolean;
  onReply: () => void;
}) {
  const [allBoosts, setAllBoosts] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const report = useRef<HTMLDialogElement>(null);
  const reaction = useReaction(post.reactions, post.myReaction);
  const boosts = post.boosts ?? [];
  const shownBoosts = allBoosts ? boosts : boosts.slice(0, BOOSTS_SHOWN);

  return (
    <li
      id={`floor-${post.floor}`}
      data-floor={post.floor}
      className={cn(
        // A faint rule above each post, starting under the name like the body does.
        "relative scroll-mt-20 px-3 py-5 before:absolute before:top-0 before:right-3 before:left-3 before:h-px before:bg-border/70 first:before:hidden sm:px-4 sm:before:right-4 sm:before:left-[4.25rem]",
        post.accepted &&
          "my-2 rounded-2xl border border-success/30 bg-success/[0.04] before:hidden [&+li]:before:hidden",
      )}
    >
      {post.accepted && (
        <div className="mb-3 inline-flex items-center gap-1 text-meta font-medium text-success">
          <CircleCheck className="size-4" /> 已采纳
        </div>
      )}
      <div className="flex items-center gap-3">
        <UserAvatar user={post.author} className="size-10 max-sm:size-9" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="mr-0.5 text-body font-semibold">{post.author.name}</span>
          <UserBadges user={post.author} op={op} />
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {post.fromQQ && (
              <MessagesSquare className="size-3.5" aria-label="来自群聊">
                <title>来自群聊</title>
              </MessagesSquare>
            )}
            {parent && (
              <button
                type="button"
                aria-expanded={parentOpen}
                title={`回复 #${parent.floor}，点开查看`}
                onClick={() => setParentOpen(!parentOpen)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1 hover:bg-accent hover:text-foreground",
                  parentOpen && "bg-accent text-foreground",
                )}
              >
                <Forward className="size-3.5" />
                <UserAvatar user={parent.author} className="size-5 text-2xs" />
                {parent.author.name}
              </button>
            )}
            {post.time}
            <a href={`#floor-${post.floor}`} className="tabular-nums hover:text-foreground">
              #{post.floor}
            </a>
            {unread !== undefined && (
              <span
                title={unread ? "未读" : undefined}
                className={cn(
                  "size-2 rounded-full bg-primary transition-opacity duration-1000",
                  !unread && "opacity-0",
                )}
              />
            )}
          </span>
        </div>
      </div>

      {/* Indented under the name on wider screens; full width on phones. */}
      <div className="sm:pl-[3.25rem]">
        {parent && parentOpen && (
          <div className="mt-3 rounded-xl border-l-2 border-border bg-secondary/40 px-3 py-1">
            <PostPreview post={parent} jump="up" />
          </div>
        )}
        <div className={cn(PROSE, "mt-2")} dangerouslySetInnerHTML={{ __html: post.html }} />

        {/* Relative: the boost input floats from this row when there are no boosts yet. */}
        <div className="relative mt-4 flex flex-wrap items-center gap-x-1 gap-y-2">
          <ReactionSummary sorted={reaction.sorted} />
          {replies.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={repliesOpen}
              onClick={() => setRepliesOpen(!repliesOpen)}
              className={cn("text-muted-foreground", repliesOpen && "bg-accent text-foreground")}
            >
              {replies.length} 个回复 {repliesOpen ? <ChevronUp /> : <ChevronDown />}
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
                title={b.user.name}
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
            {replies.map((r) => (
              <li key={r.id}>
                <PostPreview post={r} jump="down" />
              </li>
            ))}
          </ol>
        )}
      </div>

      <ReportDialog ref={report} floor={post.floor} />
    </li>
  );
}

// A compact copy of another floor, with a way to jump to where it sits in the thread.
function PostPreview({ post, jump }: { post: Post; jump: "up" | "down" }) {
  const Arrow = jump === "up" ? ArrowUp : ArrowDown;
  return (
    <div className="relative flex gap-3 py-3">
      <UserAvatar user={post.author} className="size-9 ring-4 ring-background" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="text-sm font-semibold">{post.author.name}</span>
          <UserBadges user={post.author} />
          <a
            href={`#floor-${post.floor}`}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Arrow className="size-3.5" /> 跳到 #{post.floor}
          </a>
        </div>
        <div className={cn(PROSE, "mt-1")} dangerouslySetInnerHTML={{ __html: post.html }} />
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
  const me = useRouteLoaderData<typeof forumLoader>("routes/forum-layout")?.me;
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
          {me && <UserAvatar user={{ id: me.id, name: me.display_name }} className="size-7" />}
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
