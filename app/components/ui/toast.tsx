import { useSyncExternalStore } from "react";

// Short messages at the bottom of the screen, in place of window.alert: something failed, and
// why. Kept outside React so any handler can raise one; <Toaster /> in the root shows them.
type Toast = { id: number; message: string };

let toasts: Toast[] = [];
let lastId = 0;
const listeners = new Set<() => void>();

function set(next: Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

export function toast(message: string) {
  const id = ++lastId;
  set([...toasts, { id, message }]);
  setTimeout(() => set(toasts.filter((t) => t.id !== id)), 4000);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const none: Toast[] = [];

export function Toaster() {
  const shown = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => none,
  );
  return (
    <output className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-4">
      {shown.map((t) => (
        <p
          key={t.id}
          className="max-w-sm rounded-xl bg-foreground px-4 py-2 text-sm text-background shadow-lg animate-in fade-in slide-in-from-bottom-2"
        >
          {t.message}
        </p>
      ))}
    </output>
  );
}
