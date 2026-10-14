import {
  ArrowRightLeft,
  CircleCheck,
  Clock,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Shield,
  Sparkles,
  VenetianMask,
} from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { BoardBadge } from "~/components/board-badge";
import { Dropdown, menuItem } from "~/components/disclosure";
import { TagPicker } from "~/components/tag-picker";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Dialog } from "~/components/ui/dialog";
import { Select } from "~/components/ui/select";
import { useBoards } from "~/forum";
import type { ThreadDetail } from "~/api-types";
import { ReviewItems } from "./review-items.tsx";

// The title and what is known about the thread. Its author can retitle and retag it; moderators
// also pin, feature, lock, move and review it.
export function ThreadHeader({
  thread,
  current,
  editable,
  staff,
  reveal,
}: {
  thread: ThreadDetail;
  current: number;
  editable: boolean;
  staff: boolean;
  // For admins in a thread with anonymous people: whether they are shown as who they are, and
  // the switch.
  reveal: { shown: boolean; toggle: () => void } | null;
}) {
  const [editing, setEditing] = useState(false);
  const save = useFetcher<{ ok: true } | { ok: false; message: string }>();
  const navigate = useNavigate();
  const move = useRef<HTMLDialogElement>(null);

  // The page opens again where the reader was, with the change in it.
  useEffect(() => {
    if (save.state === "idle" && save.data?.ok)
      void navigate(`?floor=${current}`, { replace: true });
  }, [save.state, save.data, navigate, current]);

  function change(fields: Record<string, string | string[]>) {
    const form = new FormData();
    form.set("intent", "edit-thread");
    for (const [name, value] of Object.entries(fields)) {
      for (const v of [value].flat()) form.append(name, v);
    }
    void save.submit(form, { method: "post", defaultShouldRevalidate: false });
  }

  return (
    <header className="px-1 pb-4">
      {editing ? (
        <ThreadForm
          thread={thread}
          busy={save.state !== "idle"}
          onSave={(title, tags) => change({ title, tags, tags_set: "1" })}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
            <BoardBadge board={thread.board} />
            {thread.tags.map((t) => (
              <span key={t}>#{t}</span>
            ))}
            {(thread.author_anonymous || thread.anonymous_replies) && (
              <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-px">
                <VenetianMask className="size-3.5" />
                {thread.author_anonymous && thread.anonymous_replies
                  ? "全部匿名"
                  : thread.author_anonymous
                    ? "楼主匿名"
                    : thread.kind === "question"
                      ? "回答匿名"
                      : "回复匿名"}
              </span>
            )}
          </div>
          <h1 className="mt-2.5 text-xl leading-snug font-semibold tracking-tight sm:text-2xl">
            {thread.title}
            {editable && (
              <button
                type="button"
                aria-label="修改标题和标签"
                title="修改标题和标签"
                onClick={() => setEditing(true)}
                className="ml-2 inline-flex size-7 items-center justify-center rounded-lg align-middle text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Pencil className="size-4" />
              </button>
            )}
          </h1>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground tabular-nums">
        {thread.solved_floor !== null && (
          <Link
            to={`?floor=${thread.solved_floor}`}
            title="看采纳的回答"
            className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success hover:bg-success/15"
          >
            <CircleCheck className="size-3.5" /> 已解决 · #{thread.solved_floor}
          </Link>
        )}
        {thread.pinned > 0 && (
          <span className="inline-flex items-center gap-1 text-brand-strong">
            <Pin className="size-3.5 rotate-45" /> {thread.pinned === 2 ? "全站置顶" : "置顶"}
          </span>
        )}
        {thread.featured && (
          <span className="inline-flex items-center gap-1 text-warning">
            <Sparkles className="size-3.5" /> 精华
          </span>
        )}
        {thread.locked && (
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3.5" /> 已锁定
          </span>
        )}
        <span className="inline-flex items-center gap-1" title="浏览">
          <Eye className="size-3.5" /> {thread.view_count.toLocaleString()}
        </span>
        <span className="inline-flex items-center gap-1" title="回复">
          <MessageSquare className="size-3.5" /> {thread.reply_count}
        </span>
        {staff && (
          <div className="ml-auto">
            <Dropdown
              label="管理帖子"
              triggerClassName={buttonVariants({ variant: "ghost", size: "sm" })}
              trigger={
                <>
                  <Shield /> 管理
                </>
              }
            >
              {(close) => {
                const act = (fields: Record<string, string>) => {
                  close();
                  change(fields);
                };
                return (
                  <>
                    {thread.pinned === 0 ? (
                      <>
                        <button
                          type="button"
                          className={menuItem}
                          onClick={() => act({ pinned: "1" })}
                        >
                          <Pin /> 版块内置顶
                        </button>
                        <button
                          type="button"
                          className={menuItem}
                          onClick={() => act({ pinned: "2" })}
                        >
                          <Pin /> 全站置顶
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={menuItem}
                        onClick={() => act({ pinned: "0" })}
                      >
                        <PinOff /> 取消置顶
                      </button>
                    )}
                    <button
                      type="button"
                      className={menuItem}
                      onClick={() => act({ featured: String(!thread.featured) })}
                    >
                      <Sparkles /> {thread.featured ? "取消精华" : "设为精华"}
                    </button>
                    <button
                      type="button"
                      className={menuItem}
                      onClick={() => act({ locked: String(!thread.locked) })}
                    >
                      {thread.locked ? <LockOpen /> : <Lock />} {thread.locked ? "解锁" : "锁定"}
                    </button>
                    <button
                      type="button"
                      className={menuItem}
                      onClick={() => {
                        close();
                        move.current?.showModal();
                      }}
                    >
                      <ArrowRightLeft /> 移动到…
                    </button>
                    <ReviewItems status={thread.status} close={close} onReview={change} />
                    {reveal && (
                      <button
                        type="button"
                        className={menuItem}
                        onClick={() => {
                          close();
                          reveal.toggle();
                        }}
                      >
                        <VenetianMask /> {reveal.shown ? "隐藏真实身份" : "显示真实身份"}
                      </button>
                    )}
                  </>
                );
              }}
            </Dropdown>
          </div>
        )}
      </div>
      {thread.status !== "visible" && (
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-meta text-warning">
          {thread.status === "pending" ? (
            <>
              <Clock className="size-4 shrink-0" /> 等待审核：通过后其他人才能看到和回复
            </>
          ) : (
            <>
              <EyeOff className="size-4 shrink-0" /> 已隐藏：只有作者和版主能看到
            </>
          )}
        </p>
      )}
      {save.data && !save.data.ok && (
        <p role="alert" className="mt-2 text-meta text-destructive">
          {save.data.message}
        </p>
      )}
      {staff && (
        <MoveDialog ref={move} current={thread.board.slug} onMove={(board) => change({ board })} />
      )}
    </header>
  );
}

function ThreadForm({
  thread,
  busy,
  onSave,
  onCancel,
}: {
  thread: ThreadDetail;
  busy: boolean;
  onSave: (title: string, tags: string[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(thread.title);
  const [tags, setTags] = useState(thread.tags);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(title, tags);
      }}
    >
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="标题"
        required
        minLength={4}
        maxLength={80}
        className="h-11 text-base md:text-base"
      />
      <TagPicker chosen={tags} onChange={setTags} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          保存
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function MoveDialog({
  ref,
  current,
  onMove,
}: {
  ref: Ref<HTMLDialogElement>;
  current: string;
  onMove: (board: string) => void;
}) {
  const boards = useBoards();
  const [board, setBoard] = useState(current);
  return (
    <Dialog ref={ref} className="w-[min(22rem,calc(100%-2rem))]">
      <form
        method="dialog"
        onSubmit={() => {
          if (board !== current) onMove(board);
        }}
      >
        <h2 className="font-semibold">移动到版块</h2>
        <Select
          value={board}
          onValueChange={setBoard}
          options={boards.map((b) => ({ value: b.slug, label: b.name }))}
          aria-label="版块"
          className="mt-4"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={(e) => e.currentTarget.closest("dialog")?.close()}
          >
            取消
          </Button>
          <Button type="submit">移动</Button>
        </div>
      </form>
    </Dialog>
  );
}
