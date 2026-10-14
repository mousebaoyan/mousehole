import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Ellipsis,
  Flag,
  Forward,
  Link2,
  MessagesSquare,
  Pencil,
  Reply,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { useFetcher, useNavigate } from "react-router";
import { cn } from "cn";
import { Dropdown, menuItem } from "~/components/disclosure";
import { PROSE } from "~/components/prose";
import { UserAvatar } from "~/components/user-avatar";
import { UserCard } from "~/components/user-card";
import { UserBadges } from "~/components/user-badges";
import { isMine, WriterName } from "~/components/writer";
import { Button, buttonVariants } from "~/components/ui/button";
import type { PostItem, UserBrief } from "~/api-types";
import { useMe } from "~/forum";
import { Dialog } from "~/components/ui/dialog";
import { stamp } from "~/time";
import { BoostButton, BoostChip, useBoosts, type Self } from "./boosts.tsx";
import { LikeButton, ReactionSummary, useReaction } from "./reactions.tsx";
import { ReportDialog, type ReportTarget } from "./report-dialog.tsx";
import { ReviewItems, type Review } from "./review-items.tsx";

// `parent` is the floor this one replies to when it is on the page; otherwise it is fetched when
// the reader opens it. The floors that reply to this one are fetched the same way.
// `manage` holds what the reader may do to this floor besides replying: change it (edit or
// delete), read its edit history, delete the whole thread from its opening post, remove other
// people's boosts, accept it as the answer, review it. `unread` is left out for guests, whose
// reading isn't tracked; `onReply` for a thread that isn't public yet.
export function PostCard({
  post,
  threadId,
  op,
  accepted,
  unread,
  now,
  parent,
  manage,
  self,
  onReply,
  onJump,
  onEdit,
  onAccept,
  onDelete,
  onReview,
}: {
  post: PostItem;
  threadId: number;
  op: boolean;
  accepted: boolean;
  unread: boolean | undefined;
  now: number;
  parent: PostItem | undefined;
  manage: {
    change: boolean;
    history: boolean;
    deleteThread: boolean;
    moderate: boolean;
    accept: boolean;
    review: boolean;
  };
  self: Self;
  onReply: (() => void) | undefined;
  onJump: (floor: number) => void;
  onEdit: (markdown: string) => void;
  onAccept: () => void;
  onDelete: () => void;
  onReview: (review: Review) => void;
}) {
  const [parentOpen, setParentOpen] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const parentFetcher = useFetcher<PostItem>();
  const repliesFetcher = useFetcher<PostItem[]>();
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const reportBoost = (id: number, body: string) => () =>
    setReporting({ boostId: id, label: `短评「${body}」` });
  const history = useRef<HTMLDialogElement>(null);
  const historyFetcher = useFetcher<Revision[]>();
  // The Markdown to edit, fetched when 编辑 is chosen; `editing` marks a choice still waiting.
  const source = useFetcher<PostItem>();
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current || source.state !== "idle" || source.data?.body === undefined) return;
    editing.current = false;
    onEdit(source.data.body);
  }, [source.state, source.data, onEdit]);
  const me = useMe();
  const navigate = useNavigate();
  const reaction = useReaction(post, threadId);
  const boosts = useBoosts(post, threadId, self);
  const own = isMine(post.author, me, self.alias);
  const boostButton = <BoostButton mine={boosts.mine} onSave={boosts.save} />;
  const replyTo = post.reply_to;
  const target = parent ?? parentFetcher.data;

  // Its author keeps their content from guests (design §8.10).
  if (post.deleted || post.members_only) {
    return (
      <li
        id={`floor-${post.floor}`}
        data-floor={post.floor}
        className="relative scroll-mt-20 px-3 py-4 text-meta text-muted-foreground sm:px-4"
      >
        <span className="tabular-nums">#{post.floor}</span>{" "}
        {post.deleted ? "该楼已删除" : "仅成员可见，登录后查看"}
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
        <UserCard user={post.author} className="flex rounded-full">
          <UserAvatar user={post.author} thread={threadId} className="size-10 max-sm:size-9" />
        </UserCard>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          <UserCard user={post.author} className="mr-0.5 text-body font-semibold hover:underline">
            <WriterName writer={post.author} />
          </UserCard>
          <UserBadges user={post.author} op={op} mine={own} />
          {/* The opening post's state is the thread's, shown above it. */}
          {post.floor > 1 && post.status !== "visible" && (
            <span className="rounded bg-warning/10 px-1.5 py-px text-2xs font-medium text-warning">
              {post.status === "pending" ? "待审核" : "已隐藏"}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
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
                <UserAvatar user={replyTo.author} thread={threadId} className="size-5 text-2xs" />
                {/* Phones have little room on this line for a long group card. */}
                <span className="max-w-24 truncate sm:max-w-none">
                  <WriterName writer={replyTo.author} />
                </span>
              </button>
            )}
            {post.edited_at !== null &&
              (manage.history ? (
                <button
                  type="button"
                  aria-label="编辑记录"
                  title={`编辑于 ${stamp(post.edited_at, now)}，查看编辑记录`}
                  onClick={() => {
                    if (historyFetcher.state === "idle") {
                      void historyFetcher.load(`/t/${threadId}/p/${post.id}/revisions`);
                    }
                    history.current?.showModal();
                  }}
                  className="-m-1 rounded p-1 hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="size-3.5" />
                </button>
              ) : (
                <Pencil className="size-3.5" aria-label="已编辑">
                  <title>{`编辑于 ${stamp(post.edited_at, now)}`}</title>
                </Pencil>
              ))}
            {stamp(post.created_at, now)}
            <a
              href={`?floor=${post.floor}`}
              className="-m-1.5 p-1.5 tabular-nums hover:text-foreground"
            >
              #{post.floor}
            </a>
            {unread !== undefined && (
              <span
                title={unread ? "未读" : undefined}
                className={cn(
                  "-ml-1 size-2 rounded-full bg-primary transition-opacity duration-1000",
                  !unread && "opacity-0",
                )}
              />
            )}
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
          <ReactionSummary
            sorted={reaction.sorted}
            source={`/t/${threadId}/p/${post.id}/reactions`}
          />
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
          {boosts.shown.length === 0 && <div className="text-muted-foreground">{boostButton}</div>}
          <div className="ml-auto flex items-center text-muted-foreground">
            {!own && (
              <LikeButton
                mine={reaction.mine}
                onChange={(emoji) => {
                  if (!me) {
                    void navigate("/login");
                    return;
                  }
                  reaction.choose(emoji);
                }}
              />
            )}
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
                  {manage.change && (
                    <button
                      type="button"
                      className={menuItem}
                      onClick={() => {
                        close();
                        editing.current = true;
                        void source.load(`/t/${threadId}/p/${post.id}?body=markdown`);
                      }}
                    >
                      <Pencil /> 编辑
                    </button>
                  )}
                  {manage.accept && (
                    <button
                      type="button"
                      className={menuItem}
                      onClick={() => {
                        close();
                        onAccept();
                      }}
                    >
                      <CircleCheck /> {accepted ? "取消采纳" : "采纳为答案"}
                    </button>
                  )}
                  {manage.review && (
                    <ReviewItems status={post.status} close={close} onReview={onReview} />
                  )}
                  {(post.floor === 1 ? manage.deleteThread : manage.change) && (
                    <button
                      type="button"
                      className={cn(menuItem, "text-destructive [&_svg]:text-destructive")}
                      onClick={() => {
                        close();
                        onDelete();
                      }}
                    >
                      <Trash2 /> {post.floor === 1 ? "删除帖子" : "删除"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={menuItem}
                    onClick={() => {
                      close();
                      setReporting({ postId: post.id, label: ` #${post.floor}` });
                    }}
                  >
                    <Flag /> 举报
                  </button>
                </>
              )}
            </Dropdown>
            {onReply && (
              <Button variant="ghost" size="sm" onClick={onReply}>
                <Reply /> 回复
              </Button>
            )}
          </div>
        </div>

        {/* Boosts, with the rocket at the end; the boost input floats from this row. */}
        {boosts.shown.length > 0 && (
          <ul className="relative mt-2 flex flex-wrap items-center gap-1.5">
            {boosts.shown.map((b) => (
              <BoostChip
                key={"anonymous" in b.user ? `a${b.user.number}` : b.user.id}
                boost={b}
                threadId={threadId}
                removable={manage.moderate && !isMine(b.user, me, self.alias)}
                onReport={
                  me && !isMine(b.user, me, self.alias) && b.id !== null
                    ? reportBoost(b.id, b.body)
                    : undefined
                }
              />
            ))}
            {boosts.hidden > 0 && (
              <li>
                <button
                  type="button"
                  disabled={boosts.loadingAll}
                  onClick={boosts.loadAll}
                  aria-label={`还有 ${boosts.hidden} 条短评`}
                  className="h-6 rounded-full px-2 text-meta text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground"
                >
                  +{boosts.hidden}
                </button>
              </li>
            )}
            <li className="text-muted-foreground">{boostButton}</li>
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

      {reporting && (
        <ReportDialog threadId={threadId} target={reporting} onClose={() => setReporting(null)} />
      )}
      {post.edited_at !== null && manage.history && (
        <HistoryDialog ref={history} floor={post.floor} revisions={historyFetcher.data} now={now} />
      )}
    </li>
  );
}

type Revision = {
  rev: number;
  title: string | null;
  body: string;
  editor: UserBrief;
  created_at: number;
};

// Each version as it was before a change, newest first, in Markdown.
function HistoryDialog({
  ref,
  floor,
  revisions,
  now,
}: {
  ref: Ref<HTMLDialogElement>;
  floor: number;
  revisions: Revision[] | undefined;
  now: number;
}) {
  return (
    <Dialog
      ref={ref}
      className="max-h-[min(40rem,calc(100svh-2rem))] w-[min(36rem,calc(100%-2rem))] overflow-auto p-0"
    >
      <div className="flex items-center border-b px-5 py-3">
        <h2 className="font-semibold">#{floor} 的编辑记录</h2>
        <form method="dialog" className="ml-auto">
          <Button variant="ghost" size="icon-sm" aria-label="关闭">
            <X />
          </Button>
        </form>
      </div>
      <ol className="divide-y overflow-y-auto">
        {revisions === undefined && (
          <li className="px-5 py-4 text-meta text-muted-foreground">加载中…</li>
        )}
        {revisions?.map((r) => (
          <li key={r.rev} className="px-5 py-4">
            <div className="flex items-center gap-2 text-meta text-muted-foreground">
              <UserAvatar user={r.editor} className="size-5 text-2xs" />
              {r.editor.display_name} · {stamp(r.created_at, now)} 修改，之前是：
            </div>
            {r.title !== null && <p className="mt-2 font-medium">标题：{r.title}</p>}
            <pre className="mt-2 font-sans text-body leading-7 whitespace-pre-wrap">{r.body}</pre>
          </li>
        ))}
      </ol>
    </Dialog>
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
      <UserAvatar
        user={post.author}
        thread={post.thread_id}
        className="size-9 ring-4 ring-background"
      />
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
        {post.deleted || post.members_only ? (
          <p className="mt-1 text-meta text-muted-foreground">
            {post.deleted ? "该楼已删除" : "仅成员可见"}
          </p>
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
