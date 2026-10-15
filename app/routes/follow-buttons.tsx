import { Bell, BellOff, BellRing, Bookmark, Check } from "lucide-react";
import { useNavigate } from "react-router";
import { cn } from "cn";
import { Dropdown, menuItem } from "~/components/disclosure";
import { Button, buttonVariants } from "~/components/ui/button";
import { useMe } from "~/forum";
import { useSavedValue } from "~/saved-value";

// `shown` is what the button says while the level is chosen.
export const NOTIFY_LEVELS = [
  { level: "watching", label: "关注", shown: "已关注", note: "有新楼层时通知", icon: BellRing },
  { level: "normal", label: "普通", shown: "关注", note: "回复我、@我时通知", icon: Bell },
  { level: "muted", label: "静音", shown: "已静音", note: "不接收通知", icon: BellOff },
] as const;

function levelOf(raw: string | undefined) {
  return NOTIFY_LEVELS.find((l) => l.level === raw) ?? NOTIFY_LEVELS[1];
}

// Guests are sent to log in.
export function BookmarkButton({ threadId, initial }: { threadId: number; initial: boolean }) {
  const me = useMe();
  const navigate = useNavigate();
  const { value, save } = useSavedValue(
    initial,
    `/t/${threadId}`,
    "bookmarked",
    (raw) => raw === "true",
  );
  return (
    <Button
      size="lg"
      variant="outline"
      aria-pressed={value}
      onClick={() => {
        if (me) save({ intent: "bookmark", bookmarked: String(!value) });
        else void navigate("/login");
      }}
    >
      <Bookmark className={cn(value && "fill-brand text-brand")} /> {value ? "已收藏" : "收藏"}
    </Button>
  );
}

// How closely the reader follows the thread, which decides what they are notified of. Guests
// are sent to log in.
export function NotifyButton({
  threadId,
  initial,
}: {
  threadId: number;
  initial: string | undefined;
}) {
  const me = useMe();
  const navigate = useNavigate();
  const { value, save } = useSavedValue(
    levelOf(initial).level,
    `/t/${threadId}`,
    "level",
    (raw) => levelOf(raw).level,
  );
  const current = levelOf(value);
  const trigger = (
    <>
      <current.icon className={cn(value === "watching" && "text-brand")} /> {current.shown}
    </>
  );
  if (!me) {
    return (
      <Button size="lg" variant="outline" onClick={() => void navigate("/login")}>
        {trigger}
      </Button>
    );
  }
  return (
    <Dropdown
      label={`关注级别：${current.label}`}
      triggerClassName={buttonVariants({ size: "lg", variant: "outline" })}
      trigger={trigger}
    >
      {(close) =>
        NOTIFY_LEVELS.map((l) => (
          <button
            key={l.level}
            type="button"
            className={cn(menuItem, "items-start")}
            onClick={() => {
              close();
              if (l.level !== value) save({ intent: "notify", level: l.level });
            }}
          >
            <l.icon className="mt-0.5" />
            <span className="flex-1">
              <span className="block font-medium">{l.label}</span>
              <span className="block text-xs text-muted-foreground">{l.note}</span>
            </span>
            {l.level === value && <Check className="mt-0.5" />}
          </button>
        ))
      }
    </Dropdown>
  );
}
