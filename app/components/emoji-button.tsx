import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Smile } from "~/components/icons";
import { useDismiss } from "~/components/disclosure";
import { Button } from "~/components/ui/button";

const EmojiPicker = lazy(() =>
  import("./emoji-picker.tsx").then((m) => ({ default: m.EmojiPicker })),
);

// The picker's size (emoji-picker.tsx), with the gap to the button.
const PICKER_HEIGHT = 340;
const PICKER_WIDTH = 320;

// Puts an emoji at the caret of `target` and hands the new value to `onChange`.
export function insertEmoji(
  target: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  emoji: string,
  onChange: (value: string) => void,
) {
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

// Opens the picker and hands the chosen emoji to `onSelect`. The button shows `children`, a
// smiley unless said otherwise. The picker is fixed to the screen beside the button, above it
// when there is room: in the composer it would otherwise be cut off by the scrolling area it sits
// in.
export function EmojiButton({
  onSelect,
  label = "表情",
  children = <Smile />,
}: {
  onSelect: (emoji: string) => void;
  label?: string;
  children?: ReactNode;
}) {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const open = place !== null;
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setPlace(null), root);

  // Fixed in place, it would drift from the button as the page scrolls; it closes instead.
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: Event) => {
      if (!(e.target instanceof Node && root.current?.contains(e.target))) setPlace(null);
    };
    addEventListener("scroll", close, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", close, true);
      removeEventListener("resize", close);
    };
  }, [open]);

  function show(button: HTMLElement) {
    const box = button.getBoundingClientRect();
    // Its right edge under the button's, kept on the screen.
    const width = Math.min(PICKER_WIDTH, innerWidth - 32);
    const left = Math.min(Math.max(8, box.right - width), innerWidth - width - 8);
    const up = box.top >= PICKER_HEIGHT || box.top > innerHeight - box.bottom;
    setPlace(up ? { left, bottom: innerHeight - box.top + 8 } : { left, top: box.bottom + 8 });
  }

  function select(emoji: string) {
    setPlace(null);
    onSelect(emoji);
  }

  return (
    <div ref={root} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={(e) => (open ? setPlace(null) : show(e.currentTarget))}
      >
        {children}
      </Button>
      {open && (
        <div className="fixed z-50 animate-in fade-in zoom-in-95" style={place}>
          <Suspense
            fallback={
              <div className="h-80 w-[min(20rem,calc(100vw-2rem))] rounded-xl border bg-popover" />
            }
          >
            <EmojiPicker onSelect={select} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
