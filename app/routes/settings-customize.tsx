import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useFetcher } from "react-router";
import { cn } from "cn";
import { ArrowDown, ArrowUp, Award, Check, Plus, X } from "~/components/icons";
import { TIER_STYLES } from "~/components/badge-chip";
import { EmojiButton } from "~/components/emoji-button";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { stamp } from "~/time";
import type { loader as userLoader } from "./user.tsx";
import {
  DEFAULT_THEME_NAME,
  PINS_MAX,
  SHOWCASE_MAX,
  STATUS_MAX,
  THEME_NAMES,
  THEMES,
} from "../../server/modules/users/customization.ts";

// The settings page's 个性化 section (design §8.16).

// A value of the settings form kept by a control of its own, in a hidden input. Like a native
// field, it tells the form when it changes and goes back to where it started when the form is
// reset.
function useFormValue<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return undefined;
    const reset = () => setValue(initial);
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [initial]);
  function change(next: T) {
    // The hidden input has to hold the new value before the form looks at it.
    flushSync(() => setValue(next));
    input.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { value, change, input };
}

type Badge = { id: number; name: string; tier: string };

// The most a card shows.
const SHOWN_MAX = 3;

// The badges on their card: the best ones unless they pick, in the order picked; picking none
// shows none. Sent as "auto" or the IDs.
export function ShownBadgesField({ badges, shown }: { badges: Badge[]; shown: number[] | null }) {
  const { value, change, input } = useFormValue(shown);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">展示徽章</span>
      <input
        ref={input}
        type="hidden"
        name="shown_badges"
        value={value === null ? "auto" : value.join(",")}
      />
      <Select
        aria-label="展示徽章"
        value={value === null ? "auto" : "pick"}
        onValueChange={(mode) => change(mode === "auto" ? null : (shown ?? []))}
        options={[
          { value: "auto", label: "自动：金徽章在前，同档的最近得到的在前" },
          { value: "pick", label: "自己选择" },
        ]}
      />
      {value !== null &&
        (badges.length === 0 ? (
          <span className="text-meta text-muted-foreground">得到徽章后可以在这里选择</span>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {badges.map((b) => {
                const at = value.indexOf(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={at >= 0}
                    disabled={at < 0 && value.length >= SHOWN_MAX}
                    onClick={() =>
                      change(at >= 0 ? value.filter((id) => id !== b.id) : [...value, b.id])
                    }
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-offset-2 ring-offset-card disabled:opacity-40",
                      TIER_STYLES[b.tier],
                      at >= 0 && "ring-2 ring-current",
                    )}
                  >
                    {at >= 0 ? (
                      <span className="flex size-3.5 items-center justify-center rounded-full bg-current">
                        <span className="text-[0.625rem] text-card tabular-nums">{at + 1}</span>
                      </span>
                    ) : (
                      <Award className="size-3.5" aria-hidden />
                    )}
                    {b.name}
                  </button>
                );
              })}
            </div>
            <span className="text-meta text-muted-foreground">
              最多 {SHOWN_MAX} 枚，按点选的顺序显示在资料卡和主页上；一枚都不选就不展示
            </span>
          </>
        ))}
    </div>
  );
}

// One swatch per theme, in its own colour; the site's own sea teal is no theme.
export function ThemeField({ theme }: { theme: string | null }) {
  return (
    <fieldset className="flex flex-col gap-1.5 text-sm">
      <legend className="font-medium">主题色</legend>
      <div className="mt-1.5 flex flex-wrap gap-2 sm:gap-2.5">
        {[
          { key: "", name: DEFAULT_THEME_NAME },
          ...THEMES.map((key) => ({ key, name: THEME_NAMES[key] })),
        ].map((t) => (
          <label
            key={t.key}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-1",
              t.key && `theme-${t.key}`,
            )}
          >
            <input
              type="radio"
              name="theme"
              value={t.key}
              defaultChecked={(theme ?? "") === t.key}
              className="peer sr-only"
            />
            <span className="flex size-8 items-center justify-center rounded-full bg-primary sm:size-9 text-primary-foreground ring-primary ring-offset-2 ring-offset-card peer-checked:ring-2 peer-focus-visible:ring-2 [&>svg]:hidden peer-checked:[&>svg]:block">
              <Check className="size-4" />
            </span>
            <span className="text-xs text-muted-foreground">{t.name}</span>
          </label>
        ))}
      </div>
      <span className="text-meta text-muted-foreground">
        资料卡和个人主页上的按钮、链接和进度条使用这个颜色
      </span>
    </fieldset>
  );
}

// When a status clears by itself, from now. One already set keeps its time unless changed.
const CLEARS = [
  { value: "never", label: "不自动清除" },
  { value: "today", label: "今天之内" },
  { value: "3d", label: "3 天后清除" },
  { value: "7d", label: "一周后清除" },
];

export const DEFAULT_STATUS_EMOJI = "💬";

export function StatusField({
  status,
  now,
}: {
  status: { emoji: string; text: string; until: number | null } | null;
  now: number;
}) {
  const {
    value: emoji,
    change: setEmoji,
    input,
  } = useFormValue(status?.emoji ?? DEFAULT_STATUS_EMOJI);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">状态</span>
      <input ref={input} type="hidden" name="status_emoji" value={emoji} />
      <input type="hidden" name="status_was" value={status?.until ?? ""} />
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-0 flex-1 basis-56 gap-1.5">
          <EmojiButton label="状态的表情" onSelect={setEmoji}>
            <span className="text-lg leading-none">{emoji}</span>
          </EmojiButton>
          <Input
            name="status_text"
            aria-label="状态"
            defaultValue={status?.text ?? ""}
            maxLength={STATUS_MAX}
            placeholder="例如：夏令营冲刺中"
          />
        </div>
        <Select
          name="status_until"
          aria-label="自动清除"
          defaultValue={status?.until ? "keep" : "never"}
          options={[
            ...(status?.until
              ? [{ value: "keep", label: `${stamp(status.until, now)} 清除` }]
              : []),
            ...CLEARS,
          ]}
          className="w-36 shrink-0 max-sm:flex-1"
        />
      </div>
      <span className="text-meta text-muted-foreground">
        最多 {STATUS_MAX} 个字；楼层里名字旁边显示表情，点一下显示这句话。留空则不显示状态
      </span>
    </div>
  );
}

type Pin = { id: number; title: string };

// The threads on their page, in order: moved up and down, taken off, or added from their own.
export function PinsField({ pins, userId }: { pins: Pin[]; userId: number }) {
  const { value, change, input } = useFormValue(pins);
  const dialog = useRef<HTMLDialogElement>(null);
  const [picking, setPicking] = useState(false);
  function move(at: number, by: number) {
    const next = [...value];
    [next[at], next[at + by]] = [next[at + by], next[at]];
    change(next);
  }
  function open() {
    setPicking(true);
    dialog.current?.showModal();
  }
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">代表作</span>
      <input ref={input} type="hidden" name="pins" value={value.map((p) => p.id).join(",")} />
      {value.length > 0 && (
        <ol className="flex flex-col divide-y rounded-xl border">
          {value.map((p, i) => (
            <li key={p.id} className="flex items-center gap-1 py-1 pr-1 pl-3">
              <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
                {i + 1}
              </span>
              <Link to={`/t/${p.id}`} className="min-w-0 flex-1 truncate hover:text-link">
                {p.title}
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="上移"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="下移"
                disabled={i === value.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="移除"
                onClick={() => change(value.filter((q) => q.id !== p.id))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {value.length < PINS_MAX && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={open}>
          <Plus /> 添加代表作
        </Button>
      )}
      <span className="text-meta text-muted-foreground">
        从自己公开发布的帖子里选最多 {PINS_MAX} 个，按顺序排在个人主页上
      </span>
      <Dialog
        ref={dialog}
        onClose={() => setPicking(false)}
        className="w-[min(28rem,calc(100%-2rem))]"
      >
        <h2 className="font-semibold">添加代表作</h2>
        {picking && (
          <ul className="-mx-2 mt-3 max-h-[60svh] overflow-y-auto">
            <ThreadChoices
              userId={userId}
              cursor={null}
              chosen={value}
              onPick={(thread) => {
                change([...value, thread]);
                if (value.length + 1 >= PINS_MAX) dialog.current?.close();
              }}
            />
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
            完成
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

// Their own threads a page at a time, the next page loading when asked, as the user page lists
// them.
function ThreadChoices({
  userId,
  cursor,
  chosen,
  onPick,
}: {
  userId: number;
  cursor: string | null;
  chosen: Pin[];
  onPick: (thread: Pin) => void;
}) {
  const { load, data, state } = useFetcher<typeof userLoader>();
  const [more, setMore] = useState(false);
  const href = `/u/${userId}${cursor === null ? "" : `?cursor=${cursor}`}`;
  useEffect(() => {
    void load(href);
  }, [load, href]);
  if (!data?.threads) {
    return (
      <li className="px-2 py-6 text-center text-meta text-muted-foreground">
        {state === "loading" ? "加载中…" : "暂无帖子"}
      </li>
    );
  }
  if (cursor === null && data.threads.length === 0) {
    return (
      <li className="px-2 py-6 text-center text-meta text-muted-foreground">暂无公开发布的帖子</li>
    );
  }
  const full = chosen.length >= PINS_MAX;
  return (
    <>
      {data.threads.map((t) => {
        const picked = chosen.some((p) => p.id === t.id);
        return (
          <li key={t.id}>
            <button
              type="button"
              disabled={picked || full}
              onClick={() => onPick({ id: t.id, title: t.title })}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent disabled:pointer-events-none"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  (picked || full) && "text-muted-foreground",
                )}
              >
                {t.title}
              </span>
              {picked && <Check className="size-4 shrink-0 text-success" />}
            </button>
          </li>
        );
      })}
      {data.next_cursor !== null &&
        (more ? (
          <ThreadChoices
            userId={userId}
            cursor={data.next_cursor}
            chosen={chosen}
            onPick={onPick}
          />
        ) : (
          <li className="py-2 text-center">
            <button
              type="button"
              onClick={() => setMore(true)}
              className="text-meta text-muted-foreground hover:text-foreground"
            >
              加载更多
            </button>
          </li>
        ))}
    </>
  );
}

export function ShowcaseField({ showcase }: { showcase: string | null }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">展柜</span>
      <Textarea
        name="showcase"
        defaultValue={showcase ?? ""}
        maxLength={SHOWCASE_MAX}
        placeholder="介绍一下自己：方向、经历、去向……"
        className="min-h-28"
      />
      <span className="text-meta text-muted-foreground">
        最多 {SHOWCASE_MAX} 个字，显示在个人主页的个性签名下面；支持 Markdown，图片显示为链接
      </span>
    </label>
  );
}
