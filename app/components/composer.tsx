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
} from "~/components/icons";
import { browserApi } from "~/browser-api";
import { MarkdownEditor } from "~/components/markdown-editor";
import { TagPicker } from "~/components/tag-picker";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { chooseDialog, confirmDialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { useMe, usePostableBoards, useTags } from "~/forum";
import { useHydrated } from "~/hydrated";
import { fromWallClock, unixNow, wallClock } from "~/time";
import { levelName, STAFF } from "../../server/platform/site.ts";
import { QUESTION_COST } from "../../server/modules/coins/rules.ts";

type ThreadRef = { id: number; title: string };
type ReplyRef = { id: number; floor: number; name: string };
type Kind = "discussion" | "question" | "poll" | "positioning" | "lottery";

// A poll being set up, as the API takes it (design §8.11); blank options are left out on posting.
// It closes some days after posting or at a time of the author's; neither is never.
type PollDraft = {
  options: string[];
  multiple: boolean;
  max_choices: number | null;
  anonymous: boolean;
  results: "voted" | "always";
  days: number | null;
  closes_at: number | null;
};

// A lottery being set up (design §8.13); prizes without a name are left out on posting. Like a
// poll's end, it is drawn some days after posting or at a time of the author's.
type LotteryDraft = {
  prizes: { name: string; winners: number }[];
  entry: "button" | "reply";
  min_level: number;
  days: number | null;
  draws_at: number | null;
};

// A 保研定位 thread being filled in (design §8.14): the background it asks for, by BACKGROUND's
// keys, and the schools to rate, blank ones left out on posting.
type PositioningDraft = { fields: Record<string, string>; schools: string[] };

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
  lottery: LotteryDraft;
  positioning: PositioningDraft;
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
    closes_at: null,
  },
  lottery: {
    prizes: [{ name: "", winners: 1 }],
    entry: "button",
    min_level: 0,
    days: 3,
    draws_at: null,
  },
  positioning: { fields: {}, schools: [""] },
  tags: [],
  anonymous: false,
  anonymousReplies: false,
};

function filledOptions(poll: PollDraft) {
  return poll.options.map((o) => o.trim()).filter(Boolean);
}

function filledPrizes(lottery: LotteryDraft) {
  return lottery.prizes.filter((p) => p.name.trim());
}

// What a 保研定位 thread asks of its author, in the order of the table its body opens with. Every
// one is filled in, "无" where there is nothing to say; the schools go between the last two.
const BACKGROUND = [
  {
    key: "level",
    label: "本科层次与专业",
    note: "只写层次，地域选填",
    hint: "例如：山东 双非 计算机科学与技术",
  },
  { key: "rank", label: "专业排名", note: "注明综合或绩点排名", hint: "例如：3/120（2.5%）" },
  { key: "english", label: "英语", hint: "例如：六级 520" },
  { key: "awards", label: "竞赛奖项", hint: "如无请填「无」" },
  { key: "research", label: "科研与论文", hint: "如无请填「无」" },
  { key: "notes", label: "补充信息", hint: "如无请填「无」" },
] as const;

const MAX_SCHOOLS = 10;

function filledSchools(positioning: PositioningDraft) {
  return positioning.schools.map((s) => s.trim()).filter(Boolean);
}

function positioningReady(positioning: PositioningDraft) {
  return (
    BACKGROUND.every((f) => positioning.fields[f.key]?.trim()) &&
    filledSchools(positioning).length > 0
  );
}

// What a 保研定位 thread is called unless its author names it.
function positioningTitle(positioning: PositioningDraft) {
  const schools = filledSchools(positioning);
  return `求定位：${schools[0] ?? ""}${schools.length > 1 ? "等" : ""}`;
}

// A line of a two-column Markdown table; a "|" typed in would end its cell.
function tableRow(label: string, value: string) {
  return `| ${label} | ${value.trim().replaceAll("|", "\\|")} |`;
}

// The body a 保研定位 thread is posted with: its background as a table, then whatever else the
// author wrote.
function positioningBody(positioning: PositioningDraft, text: string) {
  const rows = BACKGROUND.map((f) => tableRow(f.label, positioning.fields[f.key] ?? ""));
  rows.splice(-1, 0, tableRow("目标院校", filledSchools(positioning).join("、")));
  return [["| 项目 | 内容 |", "| --- | --- |", ...rows].join("\n"), text.trim()]
    .filter(Boolean)
    .join("\n\n");
}

function lotteryReady(lottery: LotteryDraft) {
  const prizes = filledPrizes(lottery);
  return prizes.length > 0 && prizes.every((p) => p.winners >= 1 && p.winners <= 100);
}

// Unix seconds: some days from now, or the time picked.
function deadlineOf(days: number | null, at: number | null) {
  return days === null ? at : unixNow() + days * 86_400;
}

// `new`, or the thread a reply is for. Edits keep no draft: the floor itself still has the text.
function draftKey(target: ComposerTarget) {
  if (target.mode === "edit") return null;
  return target.mode === "thread" ? "new" : String(target.thread.id);
}

function isEmpty(content: Content) {
  const { fields, schools } = content.positioning;
  return (
    !content.text.trim() &&
    !content.title.trim() &&
    (content.kind !== "positioning" ||
      (Object.values(fields).every((v) => !v.trim()) && schools.every((s) => !s.trim())))
  );
}

function draftBody({ target, content }: Writing) {
  if (target.mode === "thread") {
    const { text, title, board, kind, poll, lottery, positioning, tags } = content;
    return {
      body: text,
      title,
      board: board || null,
      kind,
      poll: kind === "poll" ? poll : null,
      lottery: kind === "lottery" ? lottery : null,
      positioning: kind === "positioning" ? positioning : null,
      tags,
      author_anonymous: content.anonymous,
      anonymous_replies: content.anonymousReplies,
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
        kind: KINDS.find((k) => k.kind === draft.kind)?.kind ?? "discussion",
        poll: draft.poll ?? EMPTY.poll,
        lottery: draft.lottery ?? EMPTY.lottery,
        positioning: draft.positioning ?? EMPTY.positioning,
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
      const choice = await chooseDialog("内容尚未发布，要保存为草稿吗？", [
        { value: "", label: "继续编辑", variant: "ghost" },
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
// Room for a new thread's title, board and tags, or a poll's or lottery's settings and a few
// options or prizes, besides the text.
const SETUP_HEIGHT = 560;

function clampHeight(height: number) {
  return Math.round(Math.min(Math.max(height, MIN_HEIGHT), innerHeight * 0.85));
}

const SAVE_TEXT = { saving: "正在保存草稿…", saved: "草稿已保存", failed: "草稿保存失败" };

const SEND = {
  thread: { label: "发布", Icon: Send, field: "正文" },
  reply: { label: "回复", Icon: Reply, field: "回复内容" },
  edit: { label: "保存", Icon: Pencil, field: "修改内容" },
};

// The part of the window the on-screen keyboard leaves free: how far up from the bottom it ends,
// and how tall it is. iOS lays the keyboard over the page without resizing it, so the docked
// composer is lifted by hand; Android browsers resize the page instead (interactive-widget in
// root.tsx), which leaves nothing to lift.
function useFreeViewport() {
  const [free, setFree] = useState(() => ({ bottom: 0, height: innerHeight }));
  useEffect(() => {
    const viewport = visualViewport;
    // Missing in some older in-app browsers, which then behave like a desktop.
    if (!viewport) return undefined;
    const update = () =>
      setFree({
        bottom: Math.max(0, innerHeight - viewport.height - viewport.offsetTop),
        height: viewport.height,
      });
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return free;
}

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
  const free = useFreeViewport();
  const drag = useRef<{ y: number; height: number } | null>(null);
  const sending = useFetcher<Sent>();
  const { target, content, collapsed } = writing;
  const busy = sending.state !== "idle";
  const { label, Icon, field } = SEND[target.mode];
  const withPoll = target.mode === "thread" && content.kind === "poll";
  const withLottery = target.mode === "thread" && content.kind === "lottery";
  const withPositioning = target.mode === "thread" && content.kind === "positioning";
  // A 保研定位 thread's body is mostly its table, so the rest may stay empty.
  const ready = withPositioning
    ? content.board !== "" && positioningReady(content.positioning)
    : content.text.trim() !== "" &&
      (target.mode !== "thread" ||
        (content.board !== "" &&
          (content.kind !== "poll" || filledOptions(content.poll).length >= 2) &&
          (content.kind !== "lottery" || lotteryReady(content.lottery))));
  const setPoll = (next: PollDraft) => onChange({ ...content, poll: next });
  const setLottery = (next: LotteryDraft) => onChange({ ...content, lottery: next });
  const setPositioning = (next: PositioningDraft) => onChange({ ...content, positioning: next });

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
      form.set(
        "title",
        withPositioning && !content.title.trim()
          ? positioningTitle(content.positioning)
          : content.title,
      );
      form.set("board", content.board);
      form.set("kind", content.kind);
      form.set(
        "markdown",
        withPositioning ? positioningBody(content.positioning, content.text) : content.text,
      );
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
        form.set("closes_at", String(deadlineOf(poll.days, poll.closes_at) ?? ""));
      }
      if (withPositioning) {
        for (const school of filledSchools(content.positioning)) form.append("schools", school);
      }
      if (content.kind === "lottery") {
        const { lottery } = content;
        for (const prize of filledPrizes(lottery)) {
          form.append("prize_names", prize.name);
          form.append("prize_winners", String(prize.winners));
        }
        form.set("entry", lottery.entry);
        form.set("min_level", String(lottery.min_level));
        form.set("draws_at", String(deadlineOf(lottery.days, lottery.draws_at) ?? ""));
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

  const open = target.mode === "thread" ? Math.max(height, clampHeight(SETUP_HEIGHT)) : height;
  const shown = collapsed ? COLLAPSED_HEIGHT : open;
  return (
    <>
      <div aria-hidden="true" style={{ height: shown }} />
      <section
        aria-label={target.mode === "thread" ? "发帖" : target.mode === "edit" ? "编辑" : "回复"}
        className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-5xl flex-col rounded-t-2xl border border-b-0 bg-card shadow-[0_-12px_40px_-16px_rgb(0_0_0/0.25)] animate-in slide-in-from-bottom-8"
        style={{
          bottom: free.bottom,
          height: full && !collapsed ? free.height : Math.min(shown, free.height),
        }}
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
            {withLottery && <LotterySettings lottery={content.lottery} onChange={setLottery} />}
            {/* Scrolls when a poll's options or lottery's prizes leave the editor too little room. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
              {withPoll && <PollOptions poll={content.poll} onChange={setPoll} />}
              {withLottery && <LotteryPrizes lottery={content.lottery} onChange={setLottery} />}
              {withPositioning && (
                <PositioningFields positioning={content.positioning} onChange={setPositioning} />
              )}
              <MarkdownEditor
                value={content.text}
                onChange={(text) => onChange({ ...content, text })}
                onSubmit={send}
                label={withPositioning ? "补充说明" : field}
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
  { kind: "positioning", label: "保研定位" },
  { kind: "lottery", label: "抽奖" },
] as const;

// Where 保研定位 threads go, and the tag they come with, when the forum has them (design §8.14).
const POSITIONING_BOARD = "qa";
const POSITIONING_TAG = "定位";

// A new thread's title, board, kind and tags above its body. Picking a board takes its kind,
// unless a poll or lottery is being set up.
function ThreadFields({
  content,
  onChange,
}: {
  content: Content;
  onChange: (content: Content) => void;
}) {
  const me = useMe();
  const staff = me !== null && STAFF.includes(me.role);
  const boards = usePostableBoards();
  const forumTags = useTags();
  const id = useId();
  const positioning = content.kind === "positioning";
  return (
    <div className="flex flex-col gap-2 border-t px-4 py-2.5">
      <Input
        value={content.title}
        onChange={(e) => onChange({ ...content, title: e.target.value })}
        aria-label="标题"
        placeholder={
          positioning
            ? `标题，不填则为「${positioningTitle(content.positioning)}」`
            : "标题，把问题写清楚，比如「rank 30% 能冲华五的夏令营吗」"
        }
        maxLength={80}
        className="h-9 text-base md:text-base"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={content.board}
          onValueChange={(slug) => {
            const board = boards.find((b) => b.slug === slug);
            const kind = board?.default_kind === "question" ? "question" : "discussion";
            const kept = content.kind !== "discussion" && content.kind !== "question";
            onChange({ ...content, board: slug, kind: kept ? content.kind : kind });
          }}
          options={boards.map((b) => ({ value: b.slug, label: b.name }))}
          placeholder="选择版块"
          aria-label="版块"
          className="w-40"
        />
        <fieldset className="flex rounded-full bg-secondary p-0.5 text-sm">
          <legend className="sr-only">类型</legend>
          {KINDS.map((k) => {
            // Polls and lotteries come with L2 (design §6.6); 保研定位 is for everyone.
            const held =
              (k.kind === "poll" || k.kind === "lottery") && !staff && (me?.level ?? 0) < 2;
            return (
              <label
                key={k.kind}
                title={held ? `L2 起才能发${k.label}帖` : undefined}
                className="cursor-pointer rounded-full px-3.5 py-1 text-muted-foreground has-checked:bg-card has-checked:font-medium has-checked:text-foreground has-checked:shadow-sm has-disabled:cursor-not-allowed has-disabled:opacity-50"
              >
                <input
                  type="radio"
                  name="kind"
                  value={k.kind}
                  checked={content.kind === k.kind}
                  disabled={held}
                  onChange={() =>
                    onChange({
                      ...content,
                      kind: k.kind,
                      // Lotteries can't be anonymous (design §8.13).
                      ...(k.kind === "lottery" && { anonymous: false, anonymousReplies: false }),
                      // Only 保研定位 starts with its author anonymous.
                      ...(positioning && { anonymous: false }),
                      // Few would show their rank under their name.
                      ...(k.kind === "positioning" && {
                        anonymous: true,
                        board: boards.some((b) => b.slug === POSITIONING_BOARD)
                          ? POSITIONING_BOARD
                          : content.board,
                        tags:
                          forumTags.some((t) => t.name === POSITIONING_TAG) &&
                          !content.tags.includes(POSITIONING_TAG)
                            ? [...content.tags, POSITIONING_TAG].slice(0, 5)
                            : content.tags,
                      }),
                    })
                  }
                  className="sr-only"
                />
                {k.label}
              </label>
            );
          })}
        </fieldset>
        <TagPicker chosen={content.tags} onChange={(tags) => onChange({ ...content, tags })} />
      </div>
      {/* A question costs a coin (design §8.17). */}
      {content.kind === "question" && me && (
        <p
          className={cn(
            "text-meta",
            me.coins < QUESTION_COST ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {me.coins < QUESTION_COST
            ? `发布问答帖需要 ${QUESTION_COST} 鼠币，当前余额不足，可以先发讨论帖。每天访问论坛即可签到获得鼠币`
            : `发布问答帖消耗 ${QUESTION_COST} 鼠币，当前余额 ${me.coins}`}
        </p>
      )}
      {/* Fixed once posted, so said up front (design §8.12); lotteries have none. */}
      <div
        hidden={content.kind === "lottery"}
        className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm"
      >
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
            发布后不能更改，管理员仍能看到匿名者的身份
          </span>
        )}
      </div>
    </div>
  );
}

const MAX_OPTIONS = 20;

// Where a custom time starts: three days on, on the hour.
function defaultDeadline() {
  return Math.ceil((unixNow() + 3 * 86_400) / 3600) * 3600;
}

type Deadline = { days: number | null; at: number | null };

// When a poll closes or a lottery is drawn: some days after posting, or a time of the author's in
// Beijing time, as every time on the forum is shown. Neither is never, where that is allowed.
function DeadlinePicker({
  deadline,
  verb,
  optional,
  onChange,
}: {
  deadline: Deadline;
  verb: "截止" | "开奖";
  optional: boolean;
  onChange: (deadline: Deadline) => void;
}) {
  const options = [
    ...(optional ? [{ value: "", label: "不限时间" }] : []),
    ...[1, 3, 7].map((d) => ({ value: String(d), label: `${d} 天后${verb}` })),
    { value: "at", label: `自定义${verb}时间` },
  ];
  return (
    <>
      <Select
        value={deadline.at === null ? String(deadline.days ?? "") : "at"}
        onValueChange={(v) =>
          onChange({
            days: v && v !== "at" ? Number(v) : null,
            at: v === "at" ? defaultDeadline() : null,
          })
        }
        options={options}
        aria-label={`${verb}时间`}
        className="w-40"
      />
      {deadline.at !== null && (
        <Input
          type="datetime-local"
          value={wallClock(deadline.at)}
          onChange={(e) => {
            if (e.target.value) onChange({ days: null, at: fromWallClock(e.target.value) });
          }}
          aria-label={`${verb}时间`}
          className="h-8 w-48"
        />
      )}
    </>
  );
}

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
      <DeadlinePicker
        deadline={{ days: poll.days, at: poll.closes_at }}
        verb="截止"
        optional
        onChange={({ days, at }) => onChange({ ...poll, days, closes_at: at })}
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
        <label htmlFor={`${id}-results`}>投票前可以查看结果</label>
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
                aria-label={`删除选项 ${i + 1}`}
                title="删除"
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
          <Plus /> 添加选项
        </Button>
      )}
    </div>
  );
}

// The background, a box each, and the schools; it all becomes the table the body opens with.
function PositioningFields({
  positioning,
  onChange,
}: {
  positioning: PositioningDraft;
  onChange: (positioning: PositioningDraft) => void;
}) {
  const id = useId();
  // A field's note stands beside its name rather than in the box, where a phone would cut it off.
  const field = (f: (typeof BACKGROUND)[number]) => (
    <div key={f.key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <label htmlFor={`${id}-${f.key}`} className="shrink-0 text-meta font-medium sm:w-36">
        {f.label}
        {"note" in f && (
          <span className="font-normal text-muted-foreground max-sm:ml-2 sm:block">{f.note}</span>
        )}
      </label>
      <Input
        id={`${id}-${f.key}`}
        value={positioning.fields[f.key] ?? ""}
        onChange={(e) =>
          onChange({ ...positioning, fields: { ...positioning.fields, [f.key]: e.target.value } })
        }
        placeholder={f.hint}
        maxLength={200}
        className="h-8"
      />
    </div>
  );
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t px-4 py-2.5">
      <p className="text-meta text-muted-foreground">
        每项必填，如无请填「无」。每所目标院校会生成一行匿名投票，成员从「随便去」到「几乎不可能」中选择一项。
      </p>
      {BACKGROUND.slice(0, -1).map(field)}
      <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
        <span className="shrink-0 text-meta font-medium sm:w-36 sm:pt-1.5">目标院校</span>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          <ol className="flex w-full flex-col gap-1.5">
            {positioning.schools.map((school, i) => (
              // Schools have nothing but their place to tell them apart while being typed.
              <li key={i} className="flex items-center gap-2">
                <Input
                  value={school}
                  onChange={(e) =>
                    onChange({
                      ...positioning,
                      schools: positioning.schools.with(i, e.target.value),
                    })
                  }
                  aria-label={`目标院校 ${i + 1}`}
                  placeholder="可以写到学院或方向，例如：浙江大学计算机学院"
                  maxLength={30}
                  className="h-8"
                />
                {positioning.schools.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除目标院校 ${i + 1}`}
                    title="删除"
                    onClick={() =>
                      onChange({ ...positioning, schools: positioning.schools.toSpliced(i, 1) })
                    }
                  >
                    <X />
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {positioning.schools.length < MAX_SCHOOLS && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...positioning, schools: [...positioning.schools, ""] })}
            >
              <Plus /> 添加目标院校
            </Button>
          )}
        </div>
      </div>
      {field(BACKGROUND[BACKGROUND.length - 1])}
      <p className="text-meta text-muted-foreground">
        正文选填，可以补充方向偏好、夏令营情况等，也可以贴图。
      </p>
    </div>
  );
}

const MAX_PRIZES = 10;

const ENTRIES = [
  { value: "button", label: "直接参与" },
  { value: "reply", label: "回复参与" },
];

const MIN_LEVELS = [0, 1, 2, 3, 4, 5].map((l) => ({
  value: String(l),
  label: l === 0 ? "不限等级" : `${levelName(l)} 起`,
}));

// How the lottery works, fixed once posted; out of the scrolling part like a poll's.
function LotterySettings({
  lottery,
  onChange,
}: {
  lottery: LotteryDraft;
  onChange: (lottery: LotteryDraft) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2.5 text-sm">
      <Select
        value={lottery.entry}
        onValueChange={(v) => onChange({ ...lottery, entry: v === "reply" ? "reply" : "button" })}
        options={ENTRIES}
        aria-label="参与方式"
        className="w-32"
      />
      <Select
        value={String(lottery.min_level)}
        onValueChange={(v) => onChange({ ...lottery, min_level: Number(v) })}
        options={MIN_LEVELS}
        aria-label="参与等级要求"
        className="w-32"
      />
      <DeadlinePicker
        deadline={{ days: lottery.days, at: lottery.draws_at }}
        verb="开奖"
        optional={false}
        onChange={({ days, at }) => onChange({ ...lottery, days, draws_at: at })}
      />
    </div>
  );
}

// Drawn in this order: the first prize is filled first.
function LotteryPrizes({
  lottery,
  onChange,
}: {
  lottery: LotteryDraft;
  onChange: (lottery: LotteryDraft) => void;
}) {
  const { prizes } = lottery;
  return (
    <div className="flex shrink-0 flex-col items-start gap-2 border-t px-4 py-2.5">
      <ol className="flex w-full flex-col gap-1.5">
        {prizes.map((prize, i) => (
          // Prizes have nothing but their place to tell them apart.
          <li key={i} className="flex items-center gap-2">
            <Input
              value={prize.name}
              onChange={(e) =>
                onChange({ ...lottery, prizes: prizes.with(i, { ...prize, name: e.target.value }) })
              }
              aria-label={`奖项 ${i + 1}`}
              placeholder={i === 0 ? "奖品，例如「一等奖：机械键盘」" : `奖项 ${i + 1}`}
              maxLength={50}
              className="h-8"
            />
            <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
              抽
              <Input
                type="number"
                min={1}
                max={100}
                // Empty while being typed over, which the send button waits out.
                value={prize.winners || ""}
                onChange={(e) =>
                  onChange({
                    ...lottery,
                    prizes: prizes.with(i, {
                      ...prize,
                      winners: Math.trunc(Number(e.target.value)),
                    }),
                  })
                }
                aria-label={`奖项 ${i + 1} 抽几人`}
                className="h-8 w-16"
              />
              人
            </span>
            {prizes.length > 1 && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除奖项 ${i + 1}`}
                title="删除"
                onClick={() => onChange({ ...lottery, prizes: prizes.toSpliced(i, 1) })}
              >
                <X />
              </Button>
            )}
          </li>
        ))}
      </ol>
      {prizes.length < MAX_PRIZES && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...lottery, prizes: [...prizes, { name: "", winners: 1 }] })}
        >
          <Plus /> 添加奖项
        </Button>
      )}
    </div>
  );
}
