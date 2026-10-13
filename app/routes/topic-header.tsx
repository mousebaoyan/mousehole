import {
  ArrowRightLeft,
  CircleCheck,
  Eye,
  Lock,
  LockOpen,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Shield,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { useFetcher, useNavigate } from "react-router";
import { BoardBadge } from "~/components/board-badge";
import { Dropdown, menuItem } from "~/components/disclosure";
import { TagPicker } from "~/components/tag-picker";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { useBoards } from "~/forum";
import type { ThreadDetail } from "~/api-types";

// The title and what is known about the thread. Its author can retitle and retag it; moderators
// also pin, feature, lock and move it.
export function TopicHeader({
  thread,
  current,
  editable,
  staff,
}: {
  thread: ThreadDetail;
  current: number;
  editable: boolean;
  staff: boolean;
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
        {thread.solved_post_id !== null && (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">
            <CircleCheck className="size-3.5" /> 已解决
          </span>
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
              label="管理主题"
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
                  </>
                );
              }}
            </Dropdown>
          </div>
        )}
      </div>
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
    <dialog
      ref={ref}
      className="m-auto w-[min(22rem,calc(100%-2rem))] rounded-2xl border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/30"
    >
      <form
        method="dialog"
        onSubmit={() => {
          if (board !== current) onMove(board);
        }}
      >
        <h2 className="font-semibold">移动到版块</h2>
        <NativeSelect
          value={board}
          onChange={(e) => setBoard(e.target.value)}
          aria-label="版块"
          className="mt-4"
        >
          {boards.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.name}
            </option>
          ))}
        </NativeSelect>
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
    </dialog>
  );
}
