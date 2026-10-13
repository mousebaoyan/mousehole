import {
  AtSign,
  Bold,
  ChevronDown,
  ChevronUp,
  Code,
  Eye,
  ImagePlus,
  Link2,
  Maximize2,
  Minimize2,
  Quote,
  Reply,
  X,
} from "lucide-react";
import { createContext, use, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import { cn } from "cn";
import { EmojiButton } from "~/components/emoji-button";
import { Button } from "~/components/ui/button";

type ComposerTarget = {
  thread: { id: number; title: string };
  replyTo: { floor: number; name: string } | null;
};

type Draft = ComposerTarget & { text: string; collapsed: boolean };

const ComposerContext = createContext<(target: ComposerTarget) => void>(() => {});

export function useComposer() {
  return use(ComposerContext);
}

// Lives in the forum layout, so a reply being written stays docked while the reader moves
// to other pages, and is gone only when closed.
export function ComposerProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  function focus() {
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function open(target: ComposerTarget) {
    const sameThread = draft?.thread.id === target.thread.id;
    if (draft?.text.trim() && !sameThread && !confirm("放弃正在编辑的回复？")) return;
    setDraft({ ...target, text: sameThread ? draft.text : "", collapsed: false });
    focus();
  }

  return (
    <ComposerContext value={open}>
      {children}
      {draft && (
        <Composer
          draft={draft}
          textarea={textarea}
          onChange={(change) => {
            setDraft({ ...draft, ...change });
            if (change.collapsed === false) focus();
          }}
          onClose={() => setDraft(null)}
        />
      )}
    </ComposerContext>
  );
}

const HEIGHT_KEY = "composer-height";
const MIN_HEIGHT = 240;
const COLLAPSED_HEIGHT = 48;

const tools = [
  { label: "粗体", icon: Bold },
  { label: "引用", icon: Quote },
  { label: "代码", icon: Code },
  { label: "链接", icon: Link2 },
  { label: "图片", icon: ImagePlus },
  { label: "提及", icon: AtSign },
];

function clampHeight(height: number) {
  return Math.round(Math.min(Math.max(height, MIN_HEIGHT), innerHeight * 0.85));
}

// Docked at the bottom like Discourse's: the page stays readable above it, a spacer of the
// same height keeps the end of the page reachable, and the dragged height is remembered.
// Only mounted after a click, so reading localStorage while rendering is safe.
function Composer({
  draft,
  textarea,
  onChange,
  onClose,
}: {
  draft: Draft;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onChange: (change: Partial<Draft>) => void;
  onClose: () => void;
}) {
  const [height, setHeight] = useState(() =>
    clampHeight(Number(localStorage.getItem(HEIGHT_KEY)) || 360),
  );
  const [full, setFull] = useState(false);
  const [preview, setPreview] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const { thread, replyTo, text, collapsed } = draft;

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
          <Reply className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0">
            {replyTo ? (
              <>
                回复 <span className="font-medium">{replyTo.name}</span>
                <span className="ml-1 text-muted-foreground tabular-nums">#{replyTo.floor}</span>
              </>
            ) : (
              "回复主题"
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
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="md:hidden"
                  aria-label="预览"
                  aria-pressed={preview}
                  onClick={() => setPreview(!preview)}
                >
                  <Eye />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={full ? "还原" : "全屏"}
                  title={full ? "还原" : "全屏"}
                  onClick={() => setFull(!full)}
                >
                  {full ? <Minimize2 /> : <Maximize2 />}
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={collapsed ? "展开" : "收起"}
              title={collapsed ? "展开" : "收起"}
              onClick={() => onChange({ collapsed: !collapsed })}
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
            <div className="grid min-h-0 flex-1 border-t md:grid-cols-2">
              <div className={cn("flex min-h-0 flex-col md:border-r", preview && "max-md:hidden")}>
                <div className="flex items-center gap-0.5 border-b px-2 py-1 text-muted-foreground">
                  {tools.map((t) => (
                    <Button
                      key={t.label}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.label}
                      title={t.label}
                    >
                      <t.icon />
                    </Button>
                  ))}
                  <EmojiButton
                    target={textarea}
                    onChange={(value) => onChange({ text: value })}
                    side="top"
                  />
                </div>
                <textarea
                  ref={textarea}
                  value={text}
                  onChange={(e) => onChange({ text: e.target.value })}
                  aria-label="回复内容"
                  placeholder="支持 Markdown，可粘贴或拖入图片"
                  className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-body leading-7 outline-none placeholder:text-muted-foreground"
                />
              </div>
              {/* Draft only: the real preview is rendered by the server, the same as published posts. */}
              <div
                className={cn(
                  "min-h-0 overflow-y-auto bg-secondary/40 px-4 py-3 text-body leading-7",
                  !preview && "max-md:hidden",
                )}
              >
                {text.trim() ? (
                  text.split(/\n{2,}/).map((p, i) => (
                    <p key={i} className="mb-3 whitespace-pre-wrap">
                      {p}
                    </p>
                  ))
                ) : (
                  <p className="text-muted-foreground">预览</p>
                )}
              </div>
            </div>

            <footer className="flex items-center gap-2 border-t px-4 py-2.5">
              <Button>
                <Reply /> 回复
              </Button>
              <Button variant="ghost" onClick={onClose}>
                取消
              </Button>
            </footer>
          </>
        )}
      </section>
    </>
  );
}
