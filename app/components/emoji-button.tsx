import { Smile } from "lucide-react";
import { lazy, Suspense, useRef, useState, type RefObject } from "react";
import { cn } from "cn";
import { useDismiss } from "~/components/disclosure";
import { Button } from "~/components/ui/button";

const EmojiPicker = lazy(() =>
  import("./emoji-picker.tsx").then((m) => ({ default: m.EmojiPicker })),
);

// Inserts the chosen emoji at the caret of `target` and hands the new value to `onChange`.
export function EmojiButton({
  target,
  onChange,
  side,
}: {
  target: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  side: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root);

  function insert(emoji: string) {
    setOpen(false);
    const el = target.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    onChange(el.value.slice(0, start) + emoji + el.value.slice(end));
    const caret = start + emoji.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div ref={root} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="表情"
        title="表情"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Smile />
      </Button>
      {open && (
        <div
          className={cn(
            "absolute right-0 z-50",
            side === "top" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          <Suspense
            fallback={
              <div className="h-80 w-[min(20rem,calc(100vw-2rem))] rounded-xl border bg-popover" />
            }
          >
            <EmojiPicker onSelect={insert} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
