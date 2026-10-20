import { useRef, useState } from "react";
import { cn } from "~/cn";
import { useDismiss } from "~/components/disclosure";

export type UserStatus = { emoji: string; text: string };

// Next to a name in a thread, only the emoji: pointing at it or tapping it shows the line
// (design §8.16).
export function StatusEmoji({ status }: { status: UserStatus }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useDismiss(open, () => setOpen(false), root);
  return (
    <span ref={root} className="group/status relative inline-flex">
      <button
        type="button"
        aria-label={`状态：${status.text}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="px-0.5 text-sm leading-none"
      >
        {status.emoji}
      </button>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 w-max max-w-48 -translate-x-1/2 rounded-lg bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow-md transition-opacity group-hover/status:opacity-100",
          open && "opacity-100",
        )}
      >
        {status.text}
      </span>
    </span>
  );
}

// On the card and the page, the whole of it.
export function StatusLine({ status, className }: { status: UserStatus; className?: string }) {
  return (
    <p className={cn("flex items-baseline gap-1.5 text-meta", className)}>
      <span aria-hidden>{status.emoji}</span>
      <span className="min-w-0">{status.text}</span>
    </p>
  );
}
