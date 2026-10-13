import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// Hand-rolled instead of Base UI's Menu and Dialog: the header is on every page, and those
// would add ~40KB gzip of JavaScript, positioning library included, for every visitor.
// Callers pass key={pathname} so a navigation closes them.

function useDismiss(open: boolean, close: () => void, inside?: RefObject<HTMLElement | null>) {
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

export function Dropdown({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useDismiss(open, () => setOpen(false), root);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          className="absolute top-full right-0 z-50 mt-2 flex w-48 flex-col rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        >
          {children}
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
