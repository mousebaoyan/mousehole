import { Check, Flag, Rocket, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { cn } from "cn";
import type { PostItem, Writer } from "~/api-types";
import { Dropdown, menuItem, useDismiss } from "~/components/disclosure";
import { EmojiButton } from "~/components/emoji-button";
import { Button } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { isMine, useShown } from "~/components/writer";
import { useMe } from "~/forum";
import { useSavedValue } from "~/saved-value";
import { confirmDialog } from "~/components/ui/dialog";
import { toast } from "~/components/ui/toast";

const BOOST_MAX = 16;

// Counts what people see as characters, so an emoji is one.
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

type Boost = PostItem["boosts"][number];

// The reader's own boost has no id here when it was just left; it is changed through the
// rocket, never by id.
type Shown = {
  id: number | null;
  user: Writer | { id: number; display_name: string; avatar_url: string | null };
  body: string;
};

// How the reader writes in a thread: their number there, and whether they write anonymously.
export type Self = { alias: number | null; anonymous: boolean };

// The floor's boosts as loaded, or all of them once asked for, with the reader's own as it
// stands: in its place when changed, last when new.
export function useBoosts(post: PostItem, threadId: number, self: Self) {
  const me = useMe();
  const all = useFetcher<{ items: Boost[] }>();
  const { value: mine, save } = useSavedValue(
    post.my_boost,
    `/t/${threadId}`,
    "body",
    (body) => body || null,
  );
  const loaded: Shown[] = all.data?.items ?? post.boosts;
  let shown = loaded;
  if (me) {
    const own = loaded.findIndex((b) => isMine(b.user, me, self.alias));
    if (own >= 0) {
      shown = loaded.flatMap((b, i) =>
        i !== own ? [b] : mine === null ? [] : [{ ...b, body: mine }],
      );
    } else if (mine !== null && (post.my_boost === null || all.data)) {
      // Otherwise it is among the ones not loaded yet.
      const user = self.anonymous
        ? {
            anonymous: true as const,
            number: self.alias ?? 0,
            display_name: self.alias === null ? "匿名" : `匿名鼠 ${self.alias}`,
          }
        : me;
      shown = [...loaded, { id: null, user, body: mine }];
    }
  }
  const count = post.boost_count + (mine === null ? 0 : 1) - (post.my_boost === null ? 0 : 1);

  return {
    shown,
    hidden: count - shown.length,
    mine,
    save: (body: string | null) => save({ intent: "boost", post_id: post.id, body: body ?? "" }),
    loadingAll: all.state !== "idle",
    loadAll: () => {
      void all.load(`/t/${threadId}/p/${post.id}/boosts`);
    },
  };
}

const chip =
  "inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-2.5 pl-0.5 text-meta";

// One boost. Other people's have a menu: members can report one, moderators remove it.
export function BoostChip({
  boost,
  threadId,
  removable,
  onReport,
}: {
  boost: Shown;
  threadId: number;
  removable: boolean;
  // Missing for one's own boosts and for guests.
  onReport?: () => void;
}) {
  const removing = useFetcher<{ ok: true } | { ok: false; message: string }>();
  useEffect(() => {
    if (removing.state === "idle" && removing.data?.ok === false) toast(removing.data.message);
  }, [removing.state, removing.data]);
  const user = useShown()(boost.user);
  if (removing.state !== "idle" || removing.data?.ok) return null;

  const content = (
    <>
      <UserAvatar user={user} thread={threadId} className="size-5 text-2xs" />
      {boost.body}
    </>
  );
  const id = boost.id;
  if (id === null || (!removable && !onReport)) {
    return (
      <li title={user.display_name} className={chip}>
        {content}
      </li>
    );
  }
  return (
    <li title={user.display_name}>
      <Dropdown
        label={`${user.display_name} 的短评：${boost.body}`}
        align="start"
        triggerClassName={cn(chip, "hover:bg-accent")}
        trigger={content}
      >
        {(close) => (
          <>
            {onReport && (
              <button
                type="button"
                className={menuItem}
                onClick={() => {
                  close();
                  onReport();
                }}
              >
                <Flag /> 举报短评
              </button>
            )}
            {removable && (
              <button
                type="button"
                className={cn(menuItem, "text-destructive [&_svg]:text-destructive")}
                onClick={async () => {
                  close();
                  if (!(await confirmDialog("删除这条短评？", "删除"))) return;
                  void removing.submit(
                    { intent: "remove-boost", boost_id: id },
                    { method: "post", action: `/t/${threadId}`, defaultShouldRevalidate: false },
                  );
                }}
              >
                <Trash2 /> 删除短评
              </button>
            )}
          </>
        )}
      </Dropdown>
    </li>
  );
}

// Floats over the content below instead of pushing it down, like linux.do's. It is placed
// against the row it is in rather than the button, so it fits on narrow screens. The reader's
// boost, if any, is changed or deleted here.
export function BoostButton({
  mine,
  onSave,
}: {
  mine: string | null;
  onSave: (body: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const me = useMe();
  const navigate = useNavigate();
  useDismiss(open, () => setOpen(false), root);
  const body = text.trim();
  const length = [...graphemes.segment(body)].length;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  return (
    <div ref={root}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={mine === null ? "短评" : "修改短评"}
        title={mine === null ? "短评" : "修改短评"}
        aria-expanded={open}
        onClick={() => {
          if (!me) {
            void navigate("/login");
            return;
          }
          setText(mine ?? "");
          setOpen(!open);
        }}
      >
        <Rocket />
      </Button>
      {open && (
        <form
          className="absolute top-full left-0 z-30 mt-2 flex w-[min(24rem,100%)] items-center gap-1 rounded-full border bg-popover py-1 pr-1 pl-1.5 shadow-lg animate-in fade-in zoom-in-95"
          onSubmit={(e) => {
            e.preventDefault();
            if (body !== mine) onSave(body);
            setOpen(false);
          }}
        >
          {me && <UserAvatar user={me} className="size-7" />}
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="短评"
            placeholder="短评…"
            className="min-w-0 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          {length > BOOST_MAX - 4 && (
            <span
              className={cn(
                "text-xs tabular-nums",
                length > BOOST_MAX ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {length}/{BOOST_MAX}
            </span>
          )}
          <EmojiButton target={input} onChange={setText} />
          {mine !== null && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label="删除短评"
              title="删除短评"
              onClick={() => {
                onSave(null);
                setOpen(false);
              }}
            >
              <Trash2 />
            </Button>
          )}
          <Button
            type="submit"
            size="icon-sm"
            className="rounded-full"
            aria-label="发送"
            disabled={length === 0 || length > BOOST_MAX}
          >
            <Check />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            aria-label="取消"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </form>
      )}
    </div>
  );
}
