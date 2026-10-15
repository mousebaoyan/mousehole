import { Heart } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { cn } from "cn";
import type { UserBrief } from "~/api-types";
import { useDismiss } from "~/components/disclosure";
import { UserAvatar } from "~/components/user-avatar";
import { useSavedValue } from "~/saved-value";

export const REACTIONS = [
  { key: "heart", emoji: "❤️", label: "赞" },
  { key: "+1", emoji: "👍", label: "顶" },
  { key: "laughing", emoji: "😆", label: "笑" },
  { key: "open_mouth", emoji: "😮", label: "惊讶" },
  { key: "clap", emoji: "👏", label: "鼓掌" },
  { key: "tada", emoji: "🎉", label: "庆祝" },
  { key: "hugs", emoji: "🤗", label: "抱抱" },
  { key: "thinking", emoji: "🤔", label: "思考" },
  { key: "sob", emoji: "😭", label: "大哭" },
  { key: "mouse", emoji: "🐭", label: "鼠鼠" },
] as const;

export type ReactionKey = (typeof REACTIONS)[number]["key"];

type Reactions = Record<string, number>;

function emojiOf(key: string) {
  return REACTIONS.find((r) => r.key === key)?.emoji;
}

function tabClass(active: boolean) {
  return cn(
    "inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 tabular-nums hover:bg-accent",
    active && "bg-accent font-medium",
  );
}

// The reader's reaction shows at once, and the counts the floor was loaded with follow it; a
// failed save puts it back.
export function useReaction(
  post: { id: number; reactions: Reactions; my_reaction: string | null },
  threadId: number,
) {
  const { value: mine, save } = useSavedValue(
    post.my_reaction,
    `/t/${threadId}`,
    "emoji",
    (emoji) => emoji || null,
  );
  const counts: Reactions = { ...post.reactions };
  if (post.my_reaction !== null) counts[post.my_reaction] = (counts[post.my_reaction] ?? 1) - 1;
  if (mine !== null) counts[mine] = (counts[mine] ?? 0) + 1;
  const sorted = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .toSorted(([, a], [, b]) => b - a);
  return {
    sorted,
    mine,
    choose: (emoji: ReactionKey | null) =>
      save({ intent: "react", post_id: post.id, emoji: emoji ?? "" }),
  };
}

type Reactor = { user: UserBrief; emoji: string };

// The most used three, stacked, and the total; opens the list of who reacted with what, fetched
// when opened.
export function ReactionSummary({
  sorted,
  source,
}: {
  sorted: [string, number][];
  source: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const list = useFetcher<{ items: Reactor[] }>();
  useDismiss(open, () => setOpen(false), root);
  if (sorted.length === 0) return null;

  const total = sorted.reduce((sum, [, n]) => sum + n, 0);
  const reactors = (list.data?.items ?? []).filter((r) => tab === null || r.emoji === tab);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${total} 个表情回应，查看名单`}
        onClick={() => {
          if (!open && list.state === "idle") void list.load(source);
          setOpen(!open);
        }}
        className="flex h-7 items-center gap-1.5 rounded-lg px-1.5 text-meta text-muted-foreground tabular-nums hover:bg-accent"
      >
        <span className="flex -space-x-0.5 text-base">
          {sorted.slice(0, 3).map(([key]) => (
            <span key={key}>{emojiOf(key)}</span>
          ))}
        </span>
        {total}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-popover text-sm text-popover-foreground shadow-lg animate-in fade-in zoom-in-95">
          <div className="flex gap-1 overflow-x-auto border-b p-1.5">
            <button type="button" className={tabClass(tab === null)} onClick={() => setTab(null)}>
              全部
            </button>
            {sorted.map(([key, n]) => (
              <button
                key={key}
                type="button"
                className={tabClass(tab === key)}
                onClick={() => setTab(key)}
              >
                {emojiOf(key)} {n}
              </button>
            ))}
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {!list.data && <li className="px-3 py-2 text-muted-foreground">加载中…</li>}
            {reactors.map((r) => (
              <li key={r.user.id}>
                <Link
                  to={`/u/${r.user.id}`}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-accent"
                >
                  <UserAvatar user={r.user} className="size-8" />
                  <div className="min-w-0 flex-1 truncate font-medium">{r.user.display_name}</div>
                  <span className="text-lg">{emojiOf(r.emoji)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Click is a like. Hovering with a mouse, a long press on touch, or ↑ on the keyboard opens
// the other reactions.
export function LikeButton({
  mine,
  onChange,
}: {
  mine: string | null;
  onChange: (key: ReactionKey | null) => void;
}) {
  const [palette, setPalette] = useState(false);
  // Set once the reader picks one here, so it pops then and not on every liked floor as the
  // page loads.
  const [picked, setPicked] = useState(false);
  const timer = useRef(0);
  const longPress = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(palette, () => setPalette(false), root);

  function later(action: () => void, ms: number) {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(action, ms);
  }

  function choose(key: ReactionKey) {
    setPicked(true);
    onChange(mine === key ? null : key);
    setPalette(false);
  }

  return (
    <div
      ref={root}
      className="relative"
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") later(() => setPalette(true), 350);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") later(() => setPalette(false), 250);
      }}
    >
      <button
        type="button"
        aria-label={mine === null ? "赞" : `已回应 ${emojiOf(mine) ?? ""}，点击取消`}
        aria-pressed={mine !== null}
        className={cn(
          "flex size-8 items-center justify-center rounded-lg hover:bg-accent [&_svg]:size-[1.125rem]",
          mine !== null && "bg-rose-500/10 hover:bg-rose-500/15",
        )}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          longPress.current = false;
          later(() => {
            longPress.current = true;
            setPalette(true);
          }, 450);
        }}
        onPointerUp={(e) => {
          if (e.pointerType !== "mouse" && !longPress.current) clearTimeout(timer.current);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setPalette(true);
        }}
        onClick={() => {
          if (longPress.current) longPress.current = false;
          else {
            setPicked(true);
            onChange(mine === null ? "heart" : null);
          }
        }}
      >
        {/* Keyed by the reaction, so each new pick plays the pop again. */}
        <span
          key={mine}
          className={cn("flex", picked && mine !== null && "animate-[reaction-pop_300ms_ease-out]")}
        >
          {mine !== null && mine !== "heart" ? (
            <span className="text-base">{emojiOf(mine)}</span>
          ) : (
            <Heart className={cn(mine !== null && "fill-rose-500 text-rose-500")} />
          )}
        </span>
      </button>
      {palette && (
        <fieldset className="absolute right-0 bottom-full z-30 mb-2 grid w-max grid-cols-[repeat(5,2.5rem)] gap-0.5 rounded-2xl border bg-popover p-1.5 shadow-lg animate-in fade-in zoom-in-95">
          <legend className="sr-only">表情回应</legend>
          {REACTIONS.map((r) => (
            <button
              key={r.key}
              type="button"
              title={r.label}
              aria-label={r.label}
              aria-pressed={mine === r.key}
              onClick={() => choose(r.key)}
              className={cn(
                "flex size-10 items-center justify-center rounded-xl text-2xl transition-transform hover:scale-125 hover:bg-accent",
                mine === r.key && "bg-brand/20",
              )}
            >
              {r.emoji}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}
