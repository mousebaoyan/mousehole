import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  PenSquare,
  Pencil,
  Plus,
  Reply,
  Send,
  X,
} from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useFetcher, useLocation, useNavigate } from "react-router";
import { cn } from "cn";
import { browserApi } from "~/browser-api";
import { MarkdownEditor } from "~/components/markdown-editor";
import { TagPicker } from "~/components/tag-picker";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { chooseDialog, confirmDialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { useBoards, useMe } from "~/forum";
import { useHydrated } from "~/hydrated";

type ThreadRef = { id: number; title: string };
type ReplyRef = { id: number; floor: number; name: string };
type Kind = "discussion" | "question" | "poll";

// A poll being set up, as the API takes it (design §8.11); blank options are left out on posting.
type PollDraft = {
  options: string[];
  multiple: boolean;
  max_choices: number | null;
  anonymous: boolean;
  results: "voted" | "always";
  days: number | null;
};

// A new thread, a reply to one, or a change to a floor already posted.
export type ComposerTarget =
  | { mode: "thread"; board: string | null }
  | { mode: "reply"; thread: ThreadRef; replyTo: ReplyRef | null }
  | { mode: "edit"; thread: ThreadRef; post: { id: number; floor: number; markdown: string } };

// What is in the editor; the rest only matters for a new thread.
type Content = {
  text: string;
  title: string;
  board: string;
  kind: Kind;
  poll: PollDraft;
  tags: string[];
  // Design §8.12: the author, and everyone else replying.
  anonymous: boolean;
  anonymousReplies: boolean;
};

type Writing = { target: ComposerTarget; content: Content; collapsed: boolean };

// The drafts on the server as the forum layout lists them.
type DraftList = { thread: ThreadRef | null }[];

type SaveState = "saving" | "saved" | "failed" | null;

const EMPTY: Content = {
  text: "",
  title: "",
  board: "",
  kind: "discussion",
  poll: {
    options: ["", ""],
    multiple: false,
    max_choices: null,
    anonymous: false,
    results: "voted",
    days: null,
  },
  tags: [],
  anonymous: false,
  anonymousReplies: false,
};

function filledOptions(poll: PollDraft) {
  return poll.options.map((o) => o.trim()).filter(Boolean);
}

// `new`, or the thread a reply is for. Edits keep no draft: the floor itself still has the text.
function draftKey(target: ComposerTarget) {
  if (target.mode === "edit") return null;
  return target.mode === "thread" ? "new" : String(target.thread.id);
}

function isEmpty(content: Content) {
  return !content.text.trim() && !content.title.trim();
}

function draftBody({ target, content }: Writing) {
  if (target.mode === "thread") {
    const { text, title, board, kind, poll, tags, anonymous, anonymousReplies } = content;
    return {
      body: text,
      title,
      board: board || null,
      kind,
      poll: kind === "poll" ? poll : null,
      tags,
      author_anonymous: anonymous,
      anonymous_replies: anonymousReplies,
    };
  }
  return {
    body: content.text,
    reply_to_id: target.mode === "reply" ? (target.replyTo?.id ?? null) : null,
  };
}

const SAVE_AFTER_MS = 2000;

const ComposerContext = createContext<{
  open: (target: ComposerTarget, collapsed?: boolean) => void;
  drafts: Map<string, ThreadRef | null>;
}>({ open: () => {}, drafts: new Map() });

export function useComposer() {
  return use(ComposerContext).open;
}

// The reader's drafts by key, with the thread each reply is for.
export function useDrafts() {
  return use(ComposerContext).drafts;
}

// "发帖", or "继续草稿" while a new thread is among the drafts. The board is where the reader is.
export function NewThreadButton({
  board,
  ...props
}: { board: string | null } & Omit<ComponentProps<typeof Button>, "onClick" | "children">) {
  const { open, drafts } = use(ComposerContext);
  return (
    <Button {...props} onClick={() => open({ mode: "thread", board })}>
      <PenSquare /> {drafts.has("new") ? "继续草稿" : "发帖"}
    </Button>
  );
}

function keyed(list: DraftList) {
  return new Map(list.map((d) => [d.thread === null ? "new" : String(d.thread.id), d.thread]));
}

// Lives in the forum layout, so what is being written stays docked while the reader moves to
// other pages, and is gone only when posted or closed. Drafts go to the server two seconds after
// typing stops, and what is left unsaved goes out as the page closes (design §8.2).
export function ComposerProvider({
  drafts: listed,
  children,
}: {
  drafts: DraftList;
  children: ReactNode;
}) {
  const [writing, setWriting] = useState<Writing | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(null);
  // The layout lists the drafts again after each submission; saves in between add and remove.
  const [drafts, setDrafts] = useState(() => ({ listed, keys: keyed(listed) }));
  if (drafts.listed !== listed) setDrafts({ listed, keys: keyed(listed) });
  const textarea = useRef<HTMLTextAreaElement>(null);
  // What is waiting to be saved, and what each draft was when last saved.
  const pending = useRef<{ key: string; writing: Writing } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saved = useRef(new Map<string, string>());
  // The key of a draft being fetched into the composer.
  const [restoring, setRestoring] = useState<string | null>(null);
  const me = useMe();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  function setKey(key: string, thread: ThreadRef | null, present: boolean) {
    setDrafts((d) => {
      const keys = new Map(d.keys);
      if (present) keys.set(key, thread);
      else keys.delete(key);
      return { ...d, keys };
    });
  }

  // Sends what is waiting, unless it is what was saved last; an emptied draft is deleted.
  // `keepalive` lets the request go out while the page is closing.
  function flush(keepalive = false) {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    const { key, writing: w } = next;
    const json = JSON.stringify(draftBody(w));
    if (saved.current.get(key) === json) return;
    const thread = w.target.mode === "reply" ? w.target.thread : null;
    const param = { key };
    const options = { init: { keepalive } };
    if (isEmpty(w.content)) {
      saved.current.delete(key);
      setKey(key, thread, false);
      void browserApi.me.drafts[":key"].$delete({ param }, options);
      return;
    }
    setSaveState("saving");
    void (async () => {
      const res = await browserApi.me.drafts[":key"].$put({ param, json: draftBody(w) }, options);
      if (res.ok) {
        saved.current.set(key, json);
        setKey(key, thread, true);
      }
      setSaveState(res.ok ? "saved" : "failed");
    })();
  }

  function change(next: Writing) {
    setWriting(next);
    const key = draftKey(next.target);
    if (key === null) return;
    pending.current = { key, writing: next };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER_MS);
  }

  useEffect(() => {
    const leaving = () => flush(true);
    addEventListener("pagehide", leaving);
    return () => removeEventListener("pagehide", leaving);
  });

  function focus() {
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function open(target: ComposerTarget, collapsed = false) {
    if (!me) {
      void navigate("/login");
      return;
    }
    const key = draftKey(target);
    if (writing && key !== null && draftKey(writing.target) === key) {
      // The same draft: replying to another floor of the thread changes whom it answers.
      change({ ...writing, target, collapsed });
      if (!collapsed) focus();
      return;
    }
    flush();
    const content =
      target.mode === "edit"
        ? { ...EMPTY, text: target.post.markdown }
        : { ...EMPTY, board: target.mode === "thread" ? (target.board ?? "") : "" };
    show({ target, content, collapsed });
    if (!collapsed) focus();
  }

  function show(opened: Writing) {
    setSaveState(null);
    setWriting(opened);
    const key = draftKey(opened.target);
    if (key !== null && drafts.keys.has(key)) setRestoring(key);
  }

  // Fills the composer just opened with its saved draft, unless typing has begun meanwhile.
  useEffect(() => {
    if (restoring === null) return;
    const key = restoring;
    void (async () => {
      const res = await browserApi.me.drafts[":key"].$get({ param: { key } });
      setRestoring(null);
      if (!res.ok) return;
      const draft = await res.json();
      const content: Content = {
        text: draft.body,
        title: draft.title,
        board: draft.board ?? "",
        kind: draft.kind === "question" || draft.kind === "poll" ? draft.kind : "discussion",
        poll: draft.poll ?? EMPTY.poll,
        tags: draft.tags,
        anonymous: draft.author_anonymous,
        anonymousReplies: draft.anonymous_replies,
      };
      // As the server has it, so opening it again sends nothing.
      const stored: ComposerTarget =
        key === "new"
          ? { mode: "thread", board: null }
          : { mode: "reply", thread: { id: Number(key), title: "" }, replyTo: draft.reply_to };
      saved.current.set(
        key,
        JSON.stringify(draftBody({ target: stored, content, collapsed: false })),
      );
      setWriting((w) => {
        if (!w || draftKey(w.target) !== key || !isEmpty(w.content)) return w;
        const target =
          w.target.mode === "reply" && w.target.replyTo === null
            ? { ...w.target, replyTo: draft.reply_to }
            : w.target;
        return { ...w, target, content: { ...content, board: content.board || w.content.board } };
      });
    })();
  }, [restoring, saved]);

  // Arriving at a thread with a reply among the drafts, the composer waits at the bottom, folded;
  // in the browser only, so the page still hydrates as the server rendered it.
  const threadId = /^\/t\/(\d+)/.exec(pathname)?.[1];
  const [arrivedAt, setArrivedAt] = useState<string>();
  const hydrated = useHydrated();
  if (hydrated && threadId !== arrivedAt) {
    setArrivedAt(threadId);
    const thread = threadId === undefined ? undefined : drafts.keys.get(threadId);
    if (writing === null && thread) {
      show({ target: { mode: "reply", thread, replyTo: null }, content: EMPTY, collapsed: true });
    }
  }

  async function close() {
    if (!writing) return;
    const { target, content } = writing;
    if (target.mode === "edit") {
      const changed = content.text !== target.post.markdown;
      if (changed && !(await confirmDialog("放弃这次修改？", "放弃"))) return;
    } else if (!isEmpty(content)) {
      const choice = await chooseDialog("还没发出去，怎么处理？", [
        { value: "", label: "继续写", variant: "ghost" },
        { value: "discard", label: "放弃", variant: "destructive" },
        { value: "save", label: "保存草稿", variant: "default" },
      ]);
      if (choice === null) return;
      if (choice === "discard") change({ ...writing, content: EMPTY });
    }
    flush();
    setWriting(null);
  }

  // The server ends the draft along with posting it.
  function posted(to: string) {
    if (!writing) return;
    clearTimeout(timer.current);
    pending.current = null;
    const key = draftKey(writing.target);
    if (key !== null) {
      saved.current.delete(key);
      setKey(key, null, false);
    }
    setWriting(null);
    void navigate(to);
  }

  return (
    <ComposerContext value={{ open, drafts: drafts.keys }}>
      {children}
      {writing && (
        <Composer
          writing={writing}
          saveState={draftKey(writing.target) === null ? null : saveState}
          textarea={textarea}
          onChange={(content) => change({ ...writing, content })}
          onCollapse={(collapsed) => {
            setWriting({ ...writing, collapsed });
            if (!collapsed) focus();
          }}
          onClose={close}
          onPosted={posted}
        />
      )}
    </ComposerContext>
  );
}

const HEIGHT_KEY = "composer-height";
const MIN_HEIGHT = 240;
const COLLAPSED_HEIGHT = 48;
// Room for a poll's settings and a few options besides the text.
const POLL_HEIGHT = 560;

function clampHeight(height: number) {
  return Math.round(Math.min(Math.max(height, MIN_HEIGHT), innerHeight * 0.85));
}

const SAVE_TEXT = { saving: "正在保存草稿…", saved: "草稿已保存", failed: "草稿没存上" };

const SEND = {
  thread: { label: "发布", Icon: Send, field: "正文" },
  reply: { label: "回复", Icon: Reply, field: "回复内容" },
  edit: { label: "保存", Icon: Pencil, field: "修改内容" },
};

// What the page actions answer: the new thread's ID, or the floor posted or changed.
type Sent = { ok: true; id?: number; floor?: number } | { ok: false; message: string };

// Docked at the bottom like Discourse's: the page stays readable above it, a spacer of the
// same height keeps the end of the page reachable, and the dragged height is remembered.
// Only mounted after a click, so reading localStorage while rendering is safe.
function Composer({
  writing,
  saveState,
  textarea,
  onChange,
  onCollapse,
  onClose,
  onPosted,
}: {
  writing: Writing;
  saveState: SaveState;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onChange: (content: Content) => void;
  onCollapse: (collapsed: boolean) => void;
  onClose: () => void;
  onPosted: (to: string) => void;
}) {
  const [height, setHeight] = useState(() =>
    clampHeight(Number(localStorage.getItem(HEIGHT_KEY)) || 360),
  );
  const [full, setFull] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const sending = useFetcher<Sent>();
  const { target, content, collapsed } = writing;
  const busy = sending.state !== "idle";
  const ready =
    content.text.trim() !== "" &&
    (target.mode !== "thread" ||
      (content.board !== "" &&
        (content.kind !== "poll" || filledOptions(content.poll).length >= 2)));
  const { label, Icon, field } = SEND[target.mode];
  const withPoll = target.mode === "thread" && content.kind === "poll";
  const setPoll = (next: PollDraft) => onChange({ ...content, poll: next });

  useEffect(() => {
    if (sending.state !== "idle" || !sending.data?.ok) return;
    const { id, floor } = sending.data;
    onPosted(target.mode === "thread" ? `/t/${id}` : `/t/${target.thread.id}?floor=${floor}`);
  }, [sending.state, sending.data, target, onPosted]);

  function send() {
    if (!ready || busy) return;
    const options = { method: "post", defaultShouldRevalidate: false } as const;
    if (target.mode === "thread") {
      const form = new FormData();
      form.set("title", content.title);
      form.set("board", content.board);
      form.set("kind", content.kind);
      form.set("markdown", content.text);
      for (const tag of content.tags) form.append("tags", tag);
      form.set("anonymous", String(content.anonymous));
      form.set("anonymous_replies", String(content.anonymousReplies));
      if (content.kind === "poll") {
        const { poll } = content;
        for (const option of filledOptions(poll)) form.append("options", option);
        form.set("multiple", String(poll.multiple));
        form.set("max_choices", poll.multiple ? String(poll.max_choices ?? "") : "");
        form.set("poll_anonymous", String(poll.anonymous));
        form.set("results", poll.results);
        form.set("days", String(poll.days ?? ""));
      }
      void sending.submit(form, { ...options, action: "/new" });
    } else if (target.mode === "edit") {
      const { id, floor } = target.post;
      void sending.submit(
        { intent: "edit-post", post_id: id, floor, markdown: content.text },
        { ...options, action: `/t/${target.thread.id}` },
      );
    } else {
      void sending.submit(
        { markdown: content.text, ...(target.replyTo && { reply_to_id: target.replyTo.id }) },
        { ...options, action: `/t/${target.thread.id}/reply` },
      );
    }
  }

  function resize(next: number) {
    const clamped = clampHeight(next);
    setHeight(clamped);
    setFull(false);
    return clamped;
  }

  const open = withPoll ? Math.max(height, clampHeight(POLL_HEIGHT)) : height;
  const shown = collapsed ? COLLAPSED_HEIGHT : open;
  return (
    <>
      <div aria-hidden="true" style={{ height: shown }} />
      <section
        aria-label={target.mode === "thread" ? "发帖" : target.mode === "edit" ? "编辑" : "回复"}
        className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-5xl flex-col rounded-t-2xl border border-b-0 bg-card shadow-[0_-12px_40px_-16px_rgb(0_0_0/0.25)] animate-in slide-in-from-bottom-8"
        style={{ height: full && !collapsed ? "100svh" : shown }}
      >
        {!collapsed && (
          <button
            type="button"
            aria-label="拖动或用方向键调整高度"
            className="flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center rounded-t-2xl outline-none focus-visible:bg-accent"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { y: e.clientY, height: open };
            }}
            onPointerMove={(e) => {
              if (drag.current) resize(drag.current.height + drag.current.y - e.clientY);
            }}
            onPointerUp={() => {
              drag.current = null;
              localStorage.setItem(HEIGHT_KEY, String(height));
            }}
            onKeyDown={(e) => {
              const step = { ArrowUp: 40, ArrowDown: -40 }[e.key];
              if (step) localStorage.setItem(HEIGHT_KEY, String(resize(open + step)));
            }}
          >
            <span className="h-1 w-10 rounded-full bg-border" />
          </button>
        )}

        <header
          className={cn(
            "flex min-w-0 items-center gap-2 px-4 text-sm",
            collapsed ? "h-12" : "pb-2",
          )}
        >
          <Heading target={target} title={content.title} />
          <div className="ml-auto flex shrink-0 items-center text-muted-foreground">
            {!collapsed && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={full ? "还原" : "全屏"}
                title={full ? "还原" : "全屏"}
                onClick={() => setFull(!full)}
              >
                {full ? <Minimize2 /> : <Maximize2 />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={collapsed ? "展开" : "收起"}
              title={collapsed ? "展开" : "收起"}
              onClick={() => onCollapse(!collapsed)}
            >
              {collapsed ? <ChevronUp /> : <ChevronDown />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="关闭" title="关闭" onClick={onClose}>
              <X />
            </Button>
          </div>
        </header>

        {!collapsed && (
          <>
            {target.mode === "thread" && <ThreadFields content={content} onChange={onChange} />}
            {withPoll && <PollSettings poll={content.poll} onChange={setPoll} />}
            {/* Scrolls when a poll's options leave the editor too little room. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {withPoll && <PollOptions poll={content.poll} onChange={setPoll} />}
              <MarkdownEditor
                value={content.text}
                onChange={(text) => onChange({ ...content, text })}
                onSubmit={send}
                label={field}
                textarea={textarea}
                className="min-h-40 flex-1 border-t"
              />
            </div>
            <footer className="flex items-center gap-3 border-t px-4 py-2.5">
              <Button onClick={send} disabled={busy || !ready}>
                <Icon /> {busy ? "发送中…" : label}
              </Button>
              {sending.data && !sending.data.ok ? (
                <p role="alert" className="min-w-0 truncate text-meta text-destructive">
                  {sending.data.message}
                </p>
              ) : (
                saveState && (
                  <p className="text-meta text-muted-foreground">{SAVE_TEXT[saveState]}</p>
                )
              )}
            </footer>
          </>
        )}
      </section>
    </>
  );
}

function Heading({ target, title }: { target: ComposerTarget; title: string }) {
  if (target.mode === "thread") {
    return (
      <>
        <PenSquare className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0">发帖</span>
        <span className="min-w-0 truncate text-muted-foreground">{title}</span>
      </>
    );
  }
  return (
    <>
      {target.mode === "edit" ? (
        <Pencil className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <Reply className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0">
        {target.mode === "edit" ? (
          <>
            编辑 <span className="text-muted-foreground tabular-nums">#{target.post.floor}</span>
          </>
        ) : target.replyTo ? (
          <>
            回复 <span className="font-medium">{target.replyTo.name}</span>
            <span className="ml-1 text-muted-foreground tabular-nums">#{target.replyTo.floor}</span>
          </>
        ) : (
          "回复帖子"
        )}
      </span>
      <Link
        to={`/t/${target.thread.id}`}
        className="min-w-0 truncate text-muted-foreground hover:text-foreground"
      >
        {target.thread.title}
      </Link>
    </>
  );
}

const KINDS = [
  { kind: "discussion", label: "讨论" },
  { kind: "question", label: "问答" },
  { kind: "poll", label: "投票" },
] as const;

// A new thread's title, board, kind and tags above its body. Picking a board takes its kind,
// unless a poll is being set up.
function ThreadFields({
  content,
  onChange,
}: {
  content: Content;
  onChange: (content: Content) => void;
}) {
  const me = useMe();
  const staff = me?.role === "moderator" || me?.role === "admin";
  const boards = useBoards().filter((b) => b.post_role === "user" || staff);
  const id = useId();
  return (
    <div className="flex flex-col gap-2 border-t px-4 py-2.5">
      <Input
        value={content.title}
        onChange={(e) => onChange({ ...content, title: e.target.value })}
        aria-label="标题"
        placeholder="标题：把问题写清楚，比如「rank 30% 能冲华五的夏令营吗」"
        maxLength={80}
        className="h-9 text-base md:text-base"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={content.board}
          onValueChange={(slug) => {
            const board = boards.find((b) => b.slug === slug);
            const kind = board?.default_kind === "question" ? "question" : "discussion";
            onChange({ ...content, board: slug, kind: content.kind === "poll" ? "poll" : kind });
          }}
          options={boards.map((b) => ({ value: b.slug, label: b.name }))}
          placeholder="选择版块"
          aria-label="版块"
          className="w-40"
        />
        <fieldset className="flex rounded-full bg-secondary p-0.5 text-sm">
          <legend className="sr-only">类型</legend>
          {KINDS.map((k) => (
            <label
              key={k.kind}
              className="cursor-pointer rounded-full px-3.5 py-1 text-muted-foreground has-checked:bg-card has-checked:font-medium has-checked:text-foreground has-checked:shadow-sm"
            >
              <input
                type="radio"
                name="kind"
                value={k.kind}
                checked={content.kind === k.kind}
                onChange={() => onChange({ ...content, kind: k.kind })}
                className="sr-only"
              />
              {k.label}
            </label>
          ))}
        </fieldset>
        <TagPicker chosen={content.tags} onChange={(tags) => onChange({ ...content, tags })} />
      </div>
      {/* Fixed once posted, so said up front (design §8.12). */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <span className="flex items-center gap-2">
          <Checkbox
            id={`${id}-author`}
            checked={content.anonymous}
            onChange={(e) => onChange({ ...content, anonymous: e.target.checked })}
          />
          <label htmlFor={`${id}-author`}>楼主匿名</label>
        </span>
        <span className="flex items-center gap-2">
          <Checkbox
            id={`${id}-replies`}
            checked={content.anonymousReplies}
            onChange={(e) => onChange({ ...content, anonymousReplies: e.target.checked })}
          />
          <label htmlFor={`${id}-replies`}>
            {content.kind === "question" ? "回答匿名" : "回复匿名"}
          </label>
        </span>
        {(content.anonymous || content.anonymousReplies) && (
          <span className="text-meta text-muted-foreground">
            发出后不能改；除了本人和管理员，没人知道匿名的是谁
          </span>
        )}
      </div>
    </div>
  );
}

const MAX_OPTIONS = 20;

const DAYS = [
  { value: "", label: "不限时间" },
  ...[1, 3, 7, 30].map((d) => ({ value: String(d), label: `${d} 天后截止` })),
];

// How the poll works, fixed once posted. Kept out of the scrolling part, which would clip the
// dropdowns.
function PollSettings({
  poll,
  onChange,
}: {
  poll: PollDraft;
  onChange: (poll: PollDraft) => void;
}) {
  const id = useId();
  const most = [
    { value: "", label: "不限项数" },
    ...Array.from({ length: Math.max(poll.options.length - 2, 0) }, (_, i) => ({
      value: String(i + 2),
      label: `最多选 ${i + 2} 项`,
    })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-4 py-2.5 text-sm">
      <span className="flex items-center gap-2">
        <Checkbox
          id={`${id}-multiple`}
          checked={poll.multiple}
          onChange={(e) => onChange({ ...poll, multiple: e.target.checked })}
        />
        <label htmlFor={`${id}-multiple`}>多选</label>
      </span>
      {poll.multiple && (
        <Select
          value={String(poll.max_choices ?? "")}
          onValueChange={(v) => onChange({ ...poll, max_choices: v ? Number(v) : null })}
          options={most}
          aria-label="最多选几项"
          className="w-32"
        />
      )}
      <Select
        value={String(poll.days ?? "")}
        onValueChange={(v) => onChange({ ...poll, days: v ? Number(v) : null })}
        options={DAYS}
        aria-label="截止时间"
        className="w-32"
      />
      <span className="flex items-center gap-2">
        <Checkbox
          id={`${id}-anonymous`}
          checked={poll.anonymous}
          onChange={(e) => onChange({ ...poll, anonymous: e.target.checked })}
        />
        <label htmlFor={`${id}-anonymous`}>匿名投票</label>
      </span>
      <span className="flex items-center gap-2">
        <Checkbox
          id={`${id}-results`}
          checked={poll.results === "always"}
          onChange={(e) => onChange({ ...poll, results: e.target.checked ? "always" : "voted" })}
        />
        <label htmlFor={`${id}-results`}>没投票也能看结果</label>
      </span>
    </div>
  );
}

function PollOptions({ poll, onChange }: { poll: PollDraft; onChange: (poll: PollDraft) => void }) {
  return (
    <div className="flex shrink-0 flex-col items-start gap-2 border-t px-4 py-2.5">
      <ol className="flex w-full flex-col gap-1.5">
        {poll.options.map((option, i) => (
          // Options have nothing but their place to tell them apart.
          <li key={i} className="flex items-center gap-2">
            <Input
              value={option}
              onChange={(e) => onChange({ ...poll, options: poll.options.with(i, e.target.value) })}
              aria-label={`选项 ${i + 1}`}
              placeholder={`选项 ${i + 1}`}
              maxLength={50}
              className="h-8"
            />
            {poll.options.length > 2 && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删掉选项 ${i + 1}`}
                title="删掉"
                onClick={() => onChange({ ...poll, options: poll.options.toSpliced(i, 1) })}
              >
                <X />
              </Button>
            )}
          </li>
        ))}
      </ol>
      {poll.options.length < MAX_OPTIONS && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...poll, options: [...poll.options, ""] })}
        >
          <Plus /> 加一个选项
        </Button>
      )}
    </div>
  );
}
