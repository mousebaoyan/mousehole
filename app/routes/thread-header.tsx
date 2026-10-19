import { useEffect, useRef, useState, type Ref } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import {
  ArrowRightLeft,
  Check,
  CircleCheck,
  Clock,
  Eye,
  EyeOff,
  FilePen,
  HandCoins,
  Lock,
  LockOpen,
  Merge,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Shield,
  Sparkle,
  Sparkles,
  VenetianMask,
  X,
} from "~/components/icons";
import { BoardBadge } from "~/components/board-badge";
import { Dropdown, menuItem } from "~/components/disclosure";
import { TagPicker } from "~/components/tag-picker";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Dialog } from "~/components/ui/dialog";
import { Select } from "~/components/ui/select";
import { toast } from "~/components/ui/toast";
import { usePostableBoards } from "~/forum";
import { ago, stamp } from "~/time";
import type { ThreadDetail } from "~/api-types";
import { ReviewItems } from "./review-items.tsx";
import { SuggestionChanges } from "./suggestion-changes.tsx";
import { ThreadSummary } from "./thread-summary.tsx";
import { BOUNTY_ANSWER, BOUNTY_REPLY } from "../../server/modules/coins/rules.ts";
import { whyUnmergeable } from "../../server/modules/threads/merge-rules.ts";

// The title and what is known about the thread. Its author can retitle and retag it; moderators
// also pin, feature, lock, move and review it. `power` is what the reader's level gives them over
// this thread: L3 suggests changes, L4 makes them and moves it, L5 also locks it (design §6.6).
// Changes suggested for it wait under the title for its author and moderators.
export function ThreadHeader({
  thread,
  current,
  now,
  editable,
  staff,
  power,
  acceptHint,
  reveal,
}: {
  thread: ThreadDetail;
  current: number;
  now: number;
  editable: boolean;
  staff: boolean;
  power: number;
  // Whether to tell the asker that the answers on the page can be accepted.
  acceptHint: boolean;
  // For admins in a thread with anonymous people: whether they are shown as who they are, and
  // the switch.
  reveal: { shown: boolean; toggle: () => void } | null;
}) {
  const [editing, setEditing] = useState(false);
  const save = useFetcher<{ ok: true; message?: string } | { ok: false; message: string }>();
  const navigate = useNavigate();
  const move = useRef<HTMLDialogElement>(null);
  // L3 suggests what the author and those above would change themselves.
  const suggesting = !editable && power === 3 && !thread.locked;

  // The page opens again where the reader was, with the change in it.
  useEffect(() => {
    if (save.state !== "idle" || !save.data?.ok) return;
    if (save.data.message) toast(save.data.message);
    void navigate(`?floor=${current}`, { replace: true });
  }, [save.state, save.data, navigate, current]);

  function submit(intent: string, fields: Record<string, string | string[]>) {
    const form = new FormData();
    form.set("intent", intent);
    for (const [name, value] of Object.entries(fields)) {
      for (const v of [value].flat()) form.append(name, v);
    }
    void save.submit(form, { method: "post", defaultShouldRevalidate: false });
  }
  const change = (fields: Record<string, string | string[]>) => submit("edit-thread", fields);

  return (
    <header className="px-1 pb-4">
      {editing && suggesting ? (
        <SuggestForm
          thread={thread}
          busy={save.state !== "idle"}
          onSave={(fields) => submit("suggest", fields)}
          onCancel={() => setEditing(false)}
        />
      ) : editing ? (
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
          <h1 className="mt-2.5 text-xl leading-snug font-semibold tracking-tight text-pretty sm:text-2xl">
            {thread.title}
            {(editable || suggesting) && (
              <button
                type="button"
                aria-label={suggesting ? "建议修改标题、版块和标签" : "修改标题和标签"}
                title={suggesting ? "建议修改标题、版块和标签" : "修改标题和标签"}
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
        {thread.accepted_floors.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">
            <CircleCheck className="size-3.5" /> 已解决 ·
            {thread.accepted_floors.map((floor) => (
              <Link
                key={floor}
                to={`?floor=${floor}`}
                title={`查看采纳的回答 #${floor}`}
                className="rounded-full px-0.5 hover:underline"
              >
                #{floor}
              </Link>
            ))}
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
        {(staff || power >= 4) && (
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
                return staff ? (
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
                    {whyUnmergeable(thread) === null && (
                      <Link to={`/t/${thread.id}/merge`} className={menuItem} onClick={close}>
                        <Merge /> 合并帖子…
                      </Link>
                    )}
                    {thread.summary_disabled !== undefined && (
                      <button
                        type="button"
                        className={menuItem}
                        onClick={() => {
                          close();
                          submit("summary", { disabled: String(!thread.summary_disabled) });
                        }}
                      >
                        <Sparkle /> {thread.summary_disabled ? "恢复 AI 总结" : "关闭 AI 总结"}
                      </button>
                    )}
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
                ) : (
                  <>
                    {power >= 5 && (
                      <button
                        type="button"
                        className={menuItem}
                        onClick={() => act({ locked: String(!thread.locked) })}
                      >
                        {thread.locked ? <LockOpen /> : <Lock />} {thread.locked ? "解锁" : "锁定"}
                      </button>
                    )}
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
      {thread.status !== "visible" && (
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-meta text-warning">
          {thread.status === "pending" ? (
            <>
              <Clock className="size-4 shrink-0" /> 正在审核，通过后其他人才能看到
            </>
          ) : (
            <>
              <EyeOff className="size-4 shrink-0" /> 已隐藏，仅作者和版主可见
            </>
          )}
        </p>
      )}
      {acceptHint && (
        <p className="mt-3 flex gap-2 rounded-xl bg-success/10 px-3 py-2 text-meta">
          <CircleCheck className="mt-px size-4 shrink-0 text-success" />
          <span>
            有回答解决了问题？点击回答下方的<b className="font-medium text-success">采纳</b>
            按钮，回答的人会收到通知。
          </span>
        </p>
      )}
      {thread.bounty_until !== null && (
        <p className="mt-3 flex gap-2 rounded-xl bg-gold/10 px-3 py-2 text-meta">
          <HandCoins className="mt-px size-4 shrink-0 text-gold" />
          <span>
            悬赏中：回复得 {BOUNTY_REPLY} 鼠币，被采纳再得 {BOUNTY_ANSWER} 鼠币 ·{" "}
            <span className="whitespace-nowrap">{stamp(thread.bounty_until, now)} 截止</span>
          </span>
        </p>
      )}
      {save.data && !save.data.ok && (
        <p role="alert" className="mt-2 text-meta text-destructive">
          {save.data.message}
        </p>
      )}
      {thread.summary && <ThreadSummary summary={thread.summary} />}
      {thread.suggestions && thread.suggestions.length > 0 && (
        <section aria-labelledby="suggestions" className="mt-4 rounded-2xl border bg-card">
          <h2
            id="suggestions"
            className="flex items-center gap-1.5 border-b px-4 py-2.5 text-meta font-medium"
          >
            <FilePen className="size-4 text-brand-strong" /> 修改建议
            <span className="text-muted-foreground tabular-nums">{thread.suggestions.length}</span>
          </h2>
          <ul className="divide-y">
            {thread.suggestions.map((s) => (
              <li key={s.id} className="px-4 py-3.5">
                <SuggestionChanges suggestion={s} current={thread} when={ago(s.created_at, now)} />
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    disabled={save.state !== "idle"}
                    onClick={() =>
                      submit("decide-suggestion", {
                        suggestion_id: String(s.id),
                        decision: "accepted",
                      })
                    }
                  >
                    <Check /> 同意
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={save.state !== "idle"}
                    onClick={() =>
                      submit("decide-suggestion", {
                        suggestion_id: String(s.id),
                        decision: "rejected",
                      })
                    }
                  >
                    <X /> 不同意
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(staff || power >= 4) && (
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

// A new title, board and tags for L3 to suggest, with why; the author or a moderator decides.
function SuggestForm({
  thread,
  busy,
  onSave,
  onCancel,
}: {
  thread: ThreadDetail;
  busy: boolean;
  onSave: (fields: Record<string, string | string[]>) => void;
  onCancel: () => void;
}) {
  const boards = usePostableBoards();
  const [title, setTitle] = useState(thread.title);
  const [board, setBoard] = useState(thread.board.slug);
  const [tags, setTags] = useState(thread.tags);
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ title, board, tags, reason });
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
      <Select
        value={board}
        onValueChange={setBoard}
        // A board the reader can't post in stays shown as it is now.
        options={[
          ...(boards.some((b) => b.slug === thread.board.slug)
            ? []
            : [{ value: thread.board.slug, label: thread.board.name }]),
          ...boards.map((b) => ({ value: b.slug, label: b.name })),
        ]}
        aria-label="版块"
        className="sm:w-56"
      />
      <TagPicker chosen={tags} onChange={setTags} />
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-label="理由"
        placeholder="理由（选填）"
        maxLength={100}
      />
      <p className="text-meta text-muted-foreground">楼主或版主同意后生效</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          提交建议
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

// To any board for moderators; to those they may post in for others.
function MoveDialog({
  ref,
  current,
  onMove,
}: {
  ref: Ref<HTMLDialogElement>;
  current: string;
  onMove: (board: string) => void;
}) {
  const boards = usePostableBoards();
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
