import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Link, useFetcher, useRevalidator } from "react-router";
import { cn } from "cn";
import { ArrowDown, ArrowUp, Award, Check, ImagePlus, Lock, Plus, X } from "~/components/icons";
import { Backdrop } from "~/components/backdrop";
import { AvatarFrame } from "~/components/frame";
import { UserAvatar } from "~/components/user-avatar";
import { browserApi } from "~/browser-api";
import { TIER_STYLES } from "~/components/badge-chip";
import { EmojiButton } from "~/components/emoji-button";
import { Field } from "~/components/form-parts";
import { Button, buttonVariants } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { Dialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { stamp } from "~/time";
import type { loader as userLoader } from "./user.tsx";
import { BackgroundCropper, type Region } from "./background-cropper.tsx";
import {
  BACKGROUND_PRESETS,
  BACKGROUNDS,
  DEFAULT_THEME_NAME,
  FRAME_LOOKS,
  frameMoves,
  FRAMES,
  frameUnlockLabel,
  PINS_MAX,
  SHOWCASE_MAX,
  STATUS_MAX,
  THEME_NAMES,
  THEMES,
  UPLOAD_LEVEL,
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
          { value: "auto", label: "自动选择" },
          { value: "pick", label: "自己选择" },
        ]}
      />
      {value !== null &&
        (badges.length === 0 ? (
          <span className="text-meta text-muted-foreground">获得徽章后可以在这里挑选</span>
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
              最多 {SHOWN_MAX} 枚，按选择的先后排列
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
      <span className="text-meta text-muted-foreground">用在你的资料卡和个人主页上</span>
    </fieldset>
  );
}

// When a status clears by itself, from now. One already set keeps its time unless changed.
const CLEARS = [
  { value: "never", label: "不清除" },
  { value: "today", label: "今天过后清除" },
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
      <span className="text-meta text-muted-foreground">显示在你的名字旁边</span>
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
        挑最多 {PINS_MAX} 个自己的帖子，展示在个人主页上
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
      <li className="px-2 py-6 text-center text-meta text-muted-foreground">
        暂无可选的帖子，匿名发布的不能选
      </li>
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
    <Field label="展柜" hint="显示在个人主页上，支持 Markdown，但不显示图片">
      <Textarea
        name="showcase"
        defaultValue={showcase ?? ""}
        maxLength={SHOWCASE_MAX}
        placeholder="介绍一下自己：方向、经历、去向……"
        className="min-h-28"
      />
    </Field>
  );
}

// One look to pick: a radio under a preview that moves only while pointed at or chosen. A locked
// one says what opens it.
function Tile({
  name,
  value,
  label,
  checked,
  locked,
  wide,
  children,
}: {
  name: string;
  value: string;
  label: string;
  checked: boolean;
  locked: string | null;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "group/tile flex min-w-0 flex-col items-center gap-1 text-xs",
        locked === null ? "cursor-pointer" : "cursor-not-allowed",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={checked}
        disabled={locked !== null}
        className="peer sr-only"
      />
      <span
        className={cn(
          "relative w-full overflow-hidden rounded-lg border ring-primary ring-offset-2 ring-offset-card [--play:paused] group-hover/tile:[--play:running] peer-checked:ring-2 peer-checked:[--play:running] peer-focus-visible:ring-2 peer-disabled:*:not-last:opacity-55",
          wide ? "aspect-[2/1]" : "aspect-square",
        )}
      >
        {children}
        {locked !== null && (
          <span className="absolute right-1 bottom-1 flex items-center gap-0.5 rounded-md bg-black/60 px-1 py-px text-2xs font-medium text-white">
            <Lock className="size-3 shrink-0" /> {locked}
          </span>
        )}
      </span>
      <span
        className={cn(
          "truncate",
          locked === null ? "text-muted-foreground" : "text-muted-foreground/60",
        )}
      >
        {label}
      </span>
    </label>
  );
}

type BackgroundUrls = { card_url: string; profile_url: string };

// As the upload takes a region: "x,y,width,height".
function region(r: Region) {
  return `${r.left},${r.top},${r.width},${r.height}`;
}

// The presets, their own picture once uploaded, and none. Uploading happens at once, as an avatar
// does; the field is keyed by what is saved, so it starts again with the new picture chosen.
export function BackgroundField({
  background,
  urls,
  unlocked,
  owned,
}: {
  background: string | null;
  urls: BackgroundUrls | null;
  unlocked: { backgrounds: string[]; upload: boolean };
  owned: string[];
}) {
  const { revalidate } = useRevalidator();
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    if (picked) URL.revokeObjectURL(picked.url);
    setPicked(null);
  }

  async function upload(regions: Record<"card" | "profile", Region>) {
    if (!picked) return;
    setBusy(true);
    const res = await browserApi.me.background.$put({
      form: { file: picked.file, card: region(regions.card), profile: region(regions.profile) },
    });
    setBusy(false);
    if (!res.ok) {
      toast((await res.json()).error.message);
      return;
    }
    close();
    toast("背景已更换");
    await revalidate();
  }

  return (
    <fieldset className="flex flex-col gap-1.5 text-sm">
      <legend className="font-medium">背景</legend>
      <div className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-2.5 sm:grid-cols-5">
        <Tile
          name="background"
          value=""
          label="不使用"
          checked={background === null}
          locked={null}
          wide
        >
          <span className="absolute inset-0 bg-muted" />
        </Tile>
        {BACKGROUNDS.map((key) => (
          <Tile
            key={key}
            name="background"
            value={key}
            label={BACKGROUND_PRESETS[key].name}
            checked={background === key}
            locked={
              unlocked.backgrounds.includes(key) || background === key
                ? null
                : `L${BACKGROUND_PRESETS[key].level}`
            }
            wide
          >
            <Backdrop background={{ preset: key, moving: owned.includes(key) }} place="card" />
          </Tile>
        ))}
        {urls && (
          <Tile
            name="background"
            value="custom"
            label="我的图片"
            checked={background === "custom"}
            locked={null}
            wide
          >
            <Backdrop background={urls} place="card" />
          </Tile>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <label
          className={buttonVariants({
            variant: "outline",
            size: "sm",
            className: "cursor-pointer has-disabled:pointer-events-none has-disabled:opacity-50",
          })}
        >
          <ImagePlus /> {urls ? "重新上传图片" : "上传图片"}
          <input
            type="file"
            accept="image/*"
            disabled={!unlocked.upload}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) setPicked({ file, url: URL.createObjectURL(file) });
            }}
            className="sr-only"
          />
        </label>
        <span className="text-meta text-muted-foreground">
          {!unlocked.upload
            ? `L${UPLOAD_LEVEL} 起可以上传自己的图片`
            : owned.includes("custom")
              ? "支持动图"
              : "动图只留第一帧"}
        </span>
      </div>
      {picked && (
        <BackgroundCropper url={picked.url} busy={busy} onCancel={close} onDone={upload} />
      )}
    </fieldset>
  );
}

// Each frame round their own avatar.
export function FrameField({
  frame,
  unlocked,
  owned,
  me,
}: {
  frame: string | null;
  unlocked: string[];
  owned: string[];
  me: { id: number; display_name: string; avatar_url: string | null };
}) {
  return (
    <fieldset className="flex flex-col gap-1.5 text-sm">
      <legend className="font-medium">头像框</legend>
      <div className="mt-1.5 grid grid-cols-4 gap-x-2 gap-y-2.5 sm:grid-cols-6">
        <Tile name="frame" value="" label="不使用" checked={frame === null} locked={null}>
          <span className="absolute inset-0 flex items-center justify-center">
            <UserAvatar user={me} className="size-[52%]" />
          </span>
        </Tile>
        {FRAMES.map((key) => (
          <Tile
            key={key}
            name="frame"
            value={key}
            label={FRAME_LOOKS[key].name}
            checked={frame === key}
            locked={unlocked.includes(key) || frame === key ? null : frameUnlockLabel(key)}
          >
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="relative size-[52%]">
                <UserAvatar user={me} className="size-full" />
                <AvatarFrame
                  frame={{ key, moving: frameMoves(key, owned.includes(key)) }}
                  still={false}
                />
              </span>
            </span>
          </Tile>
        ))}
      </div>
    </fieldset>
  );
}
