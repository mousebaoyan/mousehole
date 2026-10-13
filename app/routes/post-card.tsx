import {
  Bookmark,
  CircleCheck,
  Ellipsis,
  Flag,
  Link2,
  MessagesSquare,
  Reply,
  Rocket,
  SmilePlus,
} from "lucide-react";
import { useRef, useState, type Ref } from "react";
import { cn } from "cn";
import { Dropdown, menuItem } from "~/components/disclosure";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import type { Post } from "~/draft-data";

// Busy posts can collect dozens of boosts; past this many they fold behind a counter.
const BOOSTS_SHOWN = 6;

const reportReasons = ["垃圾广告", "人身攻击", "违法违规", "其他"];

export function PostCard({ post, op }: { post: Post; op: boolean }) {
  const [boosting, setBoosting] = useState(false);
  const [allBoosts, setAllBoosts] = useState(false);
  const report = useRef<HTMLDialogElement>(null);
  const boosts = post.boosts ?? [];
  const shownBoosts = allBoosts ? boosts : boosts.slice(0, BOOSTS_SHOWN);

  return (
    <li
      id={`floor-${post.floor}`}
      data-floor={post.floor}
      className={cn(
        "scroll-mt-20 rounded-2xl border border-transparent px-3 py-4 sm:px-4",
        post.accepted && "border-success/30 bg-success/[0.04]",
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
          className="prose prose-neutral mt-2 max-w-none text-body leading-7 dark:prose-invert prose-p:my-2 prose-a:font-normal prose-a:text-link prose-a:no-underline hover:prose-a:underline prose-blockquote:border-brand/50 prose-blockquote:font-normal prose-blockquote:text-muted-foreground prose-blockquote:not-italic prose-code:before:content-none prose-code:after:content-none prose-pre:bg-secondary prose-pre:text-foreground prose-li:my-0.5 [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none"
          dangerouslySetInnerHTML={{ __html: post.html }}
        />

        {boosts.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {shownBoosts.map((b) => (
              <li
                key={b.user.id}
                title={b.user.name}
                className="inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pr-2.5 pl-0.5 text-meta"
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
                  className="h-full rounded-full px-2 text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  +{boosts.length - BOOSTS_SHOWN}
                </button>
              </li>
            )}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {post.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-meta tabular-nums hover:bg-accent",
                r.mine && "border-brand/50 bg-brand/15 hover:bg-brand/25",
              )}
            >
              <span>{r.emoji}</span>
              {r.count}
            </button>
          ))}
          <Button variant="ghost" size="icon-sm" aria-label="表情回应" title="表情回应">
            <SmilePlus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="短评"
            title="短评"
            aria-expanded={boosting}
            onClick={() => setBoosting(!boosting)}
          >
            <Rocket />
          </Button>
          <div className="ml-auto flex items-center text-muted-foreground">
            <Button variant="ghost" size="sm">
              <Reply /> 回复
            </Button>
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
          </div>
        </div>

        {boosting && (
          <form
            className="mt-2 flex max-w-sm items-center gap-2"
            onSubmit={(e) => e.preventDefault()}
          >
            <Input
              ref={(input) => input?.focus()}
              maxLength={16}
              placeholder="16 字以内"
              className="h-8"
            />
            <Button type="submit" size="sm" className="h-8 px-3">
              发送
            </Button>
          </form>
        )}

        {post.replies && (
          <div className="mt-3 rounded-xl bg-secondary/60 px-3 py-2">
            {post.replies.map((r) => (
              <div key={r.id} className="flex gap-2 py-1.5 text-sm leading-relaxed">
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
              <button type="button" className="py-1.5 pl-8 text-meta text-link hover:underline">
                展开其余 {post.moreReplies} 条
              </button>
            )}
          </div>
        )}
      </div>

      <ReportDialog ref={report} floor={post.floor} />
    </li>
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
