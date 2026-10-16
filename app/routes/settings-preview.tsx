import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Link } from "react-router";
import { cn } from "cn";
import { ChevronDown } from "~/components/icons";
import { Backdrop } from "~/components/backdrop";
import { BadgeChip } from "~/components/badge-chip";
import { FullCard, type FullProfile } from "~/components/user-card";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { StatusLine } from "~/components/user-status";
import {
  BACKGROUNDS,
  frameMoves,
  FRAMES,
  SHOWN_BADGES,
  THEMES,
  type Look,
} from "../../server/modules/users/customization.ts";

// The settings' live preview (design §8.16): one's own card, or the head of their page, as the
// form would save it, with a look tried on in place of the one picked.

// A look shown without being picked: one not unlocked yet, or the moving version of one.
export type TryOn = { look: Look; moving: boolean };

type Settings = {
  background_urls: { card_url: string; profile_url: string } | null;
  shown_badge_ids: number[] | null;
  badges: { id: number; name: string; tier: string }[];
  owned: { backgrounds: string[]; frames: string[] };
  coins: number;
};

// What the form holds of the looks, by the fields' names.
const NAMES = [
  "background",
  "frame",
  "theme",
  "status_emoji",
  "status_text",
  "shown_badges",
] as const;
type Looks = Record<(typeof NAMES)[number], string>;

function readLooks(form: HTMLFormElement): Looks {
  const data = new FormData(form);
  const text = (name: string) => {
    const value = data.get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    background: text("background"),
    frame: text("frame"),
    theme: text("theme"),
    status_emoji: text("status_emoji"),
    status_text: text("status_text").trim(),
    shown_badges: text("shown_badges"),
  };
}

// The form as a store outside React: read as the preview renders, and again when a field changes,
// the form is reset, or fields come anew with what is saved, as after an upload. Null on the
// server and until there is a form, when the card as saved shows.
function useFormLooks(root: RefObject<HTMLElement | null>) {
  const last = useRef<Looks | null>(null);
  function subscribe(changed: () => void) {
    const form = root.current?.closest("form");
    if (!form) return () => {};
    // A reset fires before the fields go back.
    const afterReset = () => setTimeout(changed);
    form.addEventListener("input", changed);
    form.addEventListener("change", changed);
    form.addEventListener("reset", afterReset);
    return () => {
      form.removeEventListener("input", changed);
      form.removeEventListener("change", changed);
      form.removeEventListener("reset", afterReset);
    };
  }
  return useSyncExternalStore(
    subscribe,
    () => {
      const form = root.current?.closest("form");
      if (!form) return null;
      const looks = readLooks(form);
      const was = last.current;
      // The same object while nothing changed, as the store's snapshot must be.
      if (was && NAMES.every((name) => was[name] === looks[name])) return was;
      last.current = looks;
      return looks;
    },
    () => null,
  );
}

// The card as the form would save it.
function fromForm(profile: FullProfile, settings: Settings, looks: Looks): FullProfile {
  const preset = BACKGROUNDS.find((key) => key === looks.background);
  const frame = FRAMES.find((key) => key === looks.frame);
  const shown = looks.shown_badges;
  return {
    ...profile,
    background:
      looks.background === "custom"
        ? settings.background_urls
        : preset
          ? { preset, moving: settings.owned.backgrounds.includes(preset) }
          : null,
    frame: frame
      ? { key: frame, moving: frameMoves(frame, settings.owned.frames.includes(frame)) }
      : null,
    theme: THEMES.find((key) => key === looks.theme) ?? null,
    user_status: looks.status_text ? { emoji: looks.status_emoji, text: looks.status_text } : null,
    // Back to the default rule from badges once picked, the best come first, if not quite in the
    // order the card puts them.
    badges:
      shown === "auto"
        ? settings.shown_badge_ids === null
          ? profile.badges
          : settings.badges.slice(0, SHOWN_BADGES)
        : shown
            .split(",")
            .filter(Boolean)
            .flatMap((id) => settings.badges.filter((b) => b.id === Number(id))),
  };
}

// With the look tried on in place of the one picked.
function tried(user: FullProfile, settings: Settings, { look, moving }: TryOn): FullProfile {
  if (look.kind === "frame") {
    const bought = settings.owned.frames.includes(look.key);
    return { ...user, frame: { key: look.key, moving: moving || frameMoves(look.key, bought) } };
  }
  return {
    ...user,
    background:
      look.key === "custom"
        ? settings.background_urls
        : { preset: look.key, moving: moving || settings.owned.backgrounds.includes(look.key) },
  };
}

const PLACES = [
  { place: "card", label: "资料卡" },
  { place: "page", label: "主页" },
] as const;

// Beside the looks on wide screens; on phones a strip at the top, opened into the whole preview.
export function LookPreview({
  profile,
  settings,
  tryOn,
  className,
}: {
  profile: FullProfile;
  settings: Settings;
  tryOn: TryOn | null;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const looks = useFormLooks(root);
  const [place, setPlace] = useState<(typeof PLACES)[number]["place"]>("card");
  const [open, setOpen] = useState(false);
  const picked = looks ? fromForm(profile, settings, looks) : profile;
  const user = tryOn ? tried(picked, settings, tryOn) : picked;
  return (
    <div
      ref={root}
      className={cn(
        "sticky top-14 z-20 -mx-5 -mt-2 bg-card px-5 py-2 lg:top-20 lg:mx-0 lg:mt-0 lg:p-0",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn("group w-full lg:hidden", user.theme && `theme-${user.theme}`)}
      >
        <Strip user={user} />
      </button>
      <div className={cn("flex flex-col items-center gap-3 max-lg:mt-3", !open && "max-lg:hidden")}>
        <fieldset
          aria-label="预览哪一处"
          className="inline-flex rounded-lg bg-secondary p-0.5 text-sm"
        >
          {PLACES.map((p) => (
            <button
              key={p.place}
              type="button"
              aria-pressed={p.place === place}
              onClick={() => setPlace(p.place)}
              className="rounded-md px-3 py-1 text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm"
            >
              {p.label}
            </button>
          ))}
        </fieldset>
        {/* As others see it, not to be clicked through. */}
        <div inert className="w-72">
          {place === "card" ? (
            <div className="rounded-2xl border bg-popover p-4 text-left text-sm text-popover-foreground shadow-sm">
              <FullCard profile={user} />
            </div>
          ) : (
            <PageHead user={user} />
          )}
        </div>
        <p className="text-meta text-muted-foreground">
          有 <span className="font-semibold text-foreground tabular-nums">{settings.coins}</span>{" "}
          鼠币，可以兑换动态版 ·{" "}
          <Link to="/coins" className="text-link hover:underline">
            明细
          </Link>
        </p>
      </div>
    </div>
  );
}

function Strip({ user }: { user: FullProfile }) {
  return (
    <span className="relative flex items-center gap-3 overflow-hidden rounded-xl border bg-popover p-2 pr-3 text-left">
      {user.background && (
        <>
          <Backdrop background={user.background} place="card" />
          <span className="absolute inset-0 bg-linear-to-r from-popover from-30% to-popover/40" />
        </>
      )}
      <UserAvatar user={user} className="relative size-10" frame="live" />
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{user.display_name}</span>
        {user.user_status && (
          <span className="block truncate text-meta text-muted-foreground">
            {user.user_status.emoji} {user.user_status.text}
          </span>
        )}
      </span>
      <span className="relative flex shrink-0 items-center gap-0.5 rounded-full bg-popover/90 py-0.5 pr-1.5 pl-2.5 text-meta text-muted-foreground">
        预览
        <ChevronDown className="size-4 group-aria-expanded:rotate-180" />
      </span>
    </span>
  );
}

// The top of their page, as small as the card.
function PageHead({ user }: { user: FullProfile }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border bg-background p-3 text-left",
        user.theme && `theme-${user.theme}`,
      )}
    >
      {user.background && (
        <div className="relative -mx-3 -mt-3 mb-1 aspect-[3/1] overflow-hidden">
          <Backdrop background={user.background} place="profile" />
        </div>
      )}
      <div className="flex items-start gap-3">
        <UserAvatar
          user={user}
          className={cn(
            "size-12 text-lg",
            user.background && "relative -mt-7 ring-3 ring-background",
          )}
          frame="live"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <p className="truncate font-semibold">{user.display_name}</p>
            <UserBadges user={user} />
          </div>
          {user.user_status && <StatusLine status={user.user_status} className="mt-1" />}
        </div>
      </div>
      {user.bio && <p className="mt-2 line-clamp-2 text-meta">{user.bio}</p>}
      {user.badges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {user.badges.map((b) => (
            <BadgeChip key={b.id} badge={b} />
          ))}
        </div>
      )}
    </div>
  );
}
