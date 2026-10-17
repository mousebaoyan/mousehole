import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { cn } from "cn";
import { Input } from "~/components/ui/input";

// Hand-rolled instead of Base UI's Menu and Dialog: the header is on every page, and those
// would add ~40KB gzip of JavaScript, positioning library included, for every visitor.
// Callers pass key={pathname} so a navigation closes them.

export const menuItem =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground";

// Lists longer than this get a box to narrow them down: tags, schools among them, run to dozens.
export const SEARCH_FROM = 12;

export function matching<T extends { label: string }>(items: readonly T[], query: string) {
  const q = query.trim().toLowerCase();
  return q === "" ? items : items.filter((item) => item.label.toLowerCase().includes(q));
}

// Stays at the top of a scrolling list. Takes the focus only with a mouse: on a phone the
// keyboard would cover the list before anyone asked to type.
export function SearchBox({
  value,
  onChange,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, []);
  return (
    <div className="sticky -top-1 -mx-1 -mt-1 mb-1 border-b bg-popover p-1.5">
      <Input
        ref={input}
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="搜索"
        placeholder="搜索"
      />
    </div>
  );
}

export function useDismiss(
  open: boolean,
  close: () => void,
  inside?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (open && e.key === "Escape") close();
    }
    function onPointer(e: PointerEvent) {
      const root = inside?.current;
      if (open && root && e.target instanceof Node && !root.contains(e.target)) close();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close, inside]);
}

// The edge of its trigger a panel lines up with: the one asked for, until the panel would run off
// the screen there, as one at the end of a row that wraps anywhere on a phone does. `fit` runs
// once the panel is rendered (flushSync), before the browser paints it. Against clientWidth: a
// phone widens innerWidth to take in what sticks out.
export function useEdge(panel: RefObject<HTMLElement | null>, edge: "start" | "end") {
  const [fitting, setFitting] = useState(edge);
  function fit() {
    const box = panel.current?.getBoundingClientRect();
    if (box && box.right > document.documentElement.clientWidth) setFitting("end");
    else if (box && box.left < 0) setFitting("start");
  }
  return { edge: fitting, fit };
}

export function Dropdown({
  label,
  trigger,
  triggerClassName,
  align = "end",
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  // Which edge of the trigger the menu lines up with, if it fits on the screen.
  align?: "start" | "end";
  // Gets `close` for items that act in place; links close the menu by navigating.
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const { edge, fit } = useEdge(panel, align);
  useDismiss(open, () => setOpen(false), root);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            flushSync(() => setOpen(true));
            fit();
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          className={cn(
            "absolute top-full z-50 mt-2 flex max-h-[min(24rem,70svh)] w-48 flex-col gap-0.5 overflow-y-auto rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-lg animate-in fade-in zoom-in-95",
            edge === "start" ? "left-0" : "right-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Drawer({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useDismiss(open, () => setOpen(false));
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex size-9 items-center justify-center rounded-lg hover:bg-accent lg:hidden"
      >
        {trigger}
      </button>
      {/* Portaled: the header's backdrop-filter would otherwise trap position: fixed. */}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 lg:hidden">
            <button
              type="button"
              aria-label="关闭"
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-black/30 animate-in fade-in"
            />
            <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-background p-4 pt-6 shadow-xl animate-in slide-in-from-left">
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
