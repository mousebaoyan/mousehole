import { ChevronDown, ChevronUp, Maximize2, Minimize2, Pencil, Reply, X } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { cn } from "cn";
import { MarkdownEditor } from "~/components/markdown-editor";
import { Button } from "~/components/ui/button";
import { useMe } from "~/forum";

type ComposerTarget = {
  thread: { id: number; title: string };
  replyTo: { id: number; floor: number; name: string } | null;
  // Changing a floor instead of replying: its number and its Markdown as it is.
  edit?: { postId: number; floor: number; markdown: string };
};

type Draft = ComposerTarget & { text: string; collapsed: boolean };

const ComposerContext = createContext<(target: ComposerTarget) => void>(() => {});

export function useComposer() {
  return use(ComposerContext);
}

// What is being written for each thread stays in the browser until it is posted or discarded,
// so a closed tab or another thread's reply loses nothing.
function draftKey(threadId: number) {
  return `reply-draft:${threadId}`;
}

// Lives in the forum layout, so a reply being written stays docked while the reader moves
// to other pages, and is gone only when posted or closed.
export function ComposerProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const me = useMe();
  const navigate = useNavigate();

  function focus() {
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function open(target: ComposerTarget) {
    if (!me) {
      void navigate("/login");
      return;
    }
    const sameThread = draft?.thread.id === target.thread.id && !draft.edit;
    const text =
      target.edit?.markdown ??
      (sameThread ? draft.text : (localStorage.getItem(draftKey(target.thread.id)) ?? ""));
    setDraft({ ...target, text, collapsed: false });
    focus();
  }

  // Edits aren't kept as drafts: the post itself still has the text.
  function setText(text: string) {
    if (!draft) return;
    setDraft({ ...draft, text });
    if (draft.edit) return;
    if (text.trim()) localStorage.setItem(draftKey(draft.thread.id), text);
    else localStorage.removeItem(draftKey(draft.thread.id));
  }

  function discard() {
    if (!draft) return;
    const changed = draft.edit ? draft.text !== draft.edit.markdown : draft.text.trim() !== "";
    if (changed && !confirm(draft.edit ? "放弃这次修改？" : "放弃这条回复？")) return;
    if (!draft.edit) localStorage.removeItem(draftKey(draft.thread.id));
    setDraft(null);
  }

  function posted(floor: number) {
    if (!draft) return;
    if (!draft.edit) localStorage.removeItem(draftKey(draft.thread.id));
    setDraft(null);
    void navigate(`/t/${draft.thread.id}?floor=${floor}`);
  }

  return (
    <ComposerContext value={open}>
      {children}
      {draft && (
        <Composer
          draft={draft}
          textarea={textarea}
          onText={setText}
          onCollapse={(collapsed) => {
            setDraft({ ...draft, collapsed });
            if (!collapsed) focus();
          }}
          onDiscard={discard}
          onPosted={posted}
        />
      )}
    </ComposerContext>
  );
}

const HEIGHT_KEY = "composer-height";
const MIN_HEIGHT = 240;
const COLLAPSED_HEIGHT = 48;

function clampHeight(height: number) {
  return Math.round(Math.min(Math.max(height, MIN_HEIGHT), innerHeight * 0.85));
}

// Docked at the bottom like Discourse's: the page stays readable above it, a spacer of the
// same height keeps the end of the page reachable, and the dragged height is remembered.
// Only mounted after a click, so reading localStorage while rendering is safe.
function Composer({
  draft,
  textarea,
  onText,
  onCollapse,
  onDiscard,
  onPosted,
}: {
  draft: Draft;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onText: (text: string) => void;
  onCollapse: (collapsed: boolean) => void;
  onDiscard: () => void;
  onPosted: (floor: number) => void;
}) {
  const [height, setHeight] = useState(() =>
    clampHeight(Number(localStorage.getItem(HEIGHT_KEY)) || 360),
  );
  const [full, setFull] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const reply = useFetcher<{ ok: true; floor: number } | { ok: false; message: string }>();
  const { thread, replyTo, edit, text, collapsed } = draft;
  const busy = reply.state !== "idle";

  useEffect(() => {
    if (reply.state === "idle" && reply.data?.ok) onPosted(reply.data.floor);
  }, [reply.state, reply.data, onPosted]);

  function send() {
    if (!text.trim() || busy) return;
    void reply.submit(
      edit
        ? { intent: "edit-post", post_id: edit.postId, floor: edit.floor, markdown: text }
        : { markdown: text, ...(replyTo && { reply_to_id: replyTo.id }) },
      {
        method: "post",
        action: edit ? `/t/${thread.id}` : `/t/${thread.id}/reply`,
        defaultShouldRevalidate: false,
      },
    );
  }

  function resize(next: number) {
    const clamped = clampHeight(next);
    setHeight(clamped);
    setFull(false);
    return clamped;
  }

  const shown = collapsed ? COLLAPSED_HEIGHT : height;
  return (
    <>
      <div aria-hidden="true" style={{ height: shown }} />
      <section
        aria-label="回复"
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
              drag.current = { y: e.clientY, height };
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
              if (step) localStorage.setItem(HEIGHT_KEY, String(resize(height + step)));
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
          {edit ? (
            <Pencil className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Reply className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0">
            {edit ? (
              <>
                编辑 <span className="text-muted-foreground tabular-nums">#{edit.floor}</span>
              </>
            ) : replyTo ? (
              <>
                回复 <span className="font-medium">{replyTo.name}</span>
                <span className="ml-1 text-muted-foreground tabular-nums">#{replyTo.floor}</span>
              </>
            ) : (
              "回复帖子"
            )}
          </span>
          <Link
            to={`/t/${thread.id}`}
            className="min-w-0 truncate text-muted-foreground hover:text-foreground"
          >
            {thread.title}
          </Link>
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
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭"
              title="关闭"
              onClick={onDiscard}
            >
              <X />
            </Button>
          </div>
        </header>

        {!collapsed && (
          <>
            <MarkdownEditor
              value={text}
              onChange={onText}
              onSubmit={send}
              label={edit ? "修改内容" : "回复内容"}
              textarea={textarea}
              className="flex-1 border-t"
            />
            <footer className="flex items-center gap-3 border-t px-4 py-2.5">
              <Button onClick={send} disabled={busy || !text.trim()}>
                {edit ? <Pencil /> : <Reply />}
                {busy ? "发送中…" : edit ? "保存" : "回复"}
              </Button>
              {reply.data && !reply.data.ok && (
                <p role="alert" className="min-w-0 truncate text-meta text-destructive">
                  {reply.data.message}
                </p>
              )}
            </footer>
          </>
        )}
      </section>
    </>
  );
}
