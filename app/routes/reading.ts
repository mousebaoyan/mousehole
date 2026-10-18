import { useEffect, useState } from "react";
import { browserApi } from "~/browser-api";
import { readHere } from "~/components/thread-list";

const TICK_MS = 500;
// On screen this long, a floor counts as read and its dot fades.
const READ_MS = 2000;
// Reading time counts only while the reader has scrolled or pressed a key this recently.
const IDLE_MS = 3 * 60_000;
// While reading, what was read goes out at most this often; leaving sends the rest.
const REPORT_MS = 60_000;
// The sticky header covers the top of the window.
const HEADER_PX = 56;

type Ranges = [number, number][];

function floorSet(ranges: Ranges | undefined) {
  const floors = new Set<number>();
  for (const [from, to] of ranges ?? []) for (let f = from; f <= to; f++) floors.add(f);
  return floors;
}

// 1, 2, 3, 7 → [[1, 3], [7, 7]].
function rangesOf(floors: Set<number>) {
  const ranges: Ranges = [];
  for (const f of [...floors].toSorted((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] === f - 1) last[1] = f;
    else ranges.push([f, f]);
  }
  return ranges;
}

// Sends what the thread on screen has read and not yet reported. The page's own cleanup runs only
// once the next page has loaded, too late for a list it leads back to, so root.tsx calls this
// before each navigation loads.
let flush: (() => Promise<unknown> | undefined) | undefined;

export function sendReading() {
  return flush?.();
}

// The floors the reader has read: what the server knew when the page loaded, and what they read
// since. While the page is in front, it adds up how long each floor has been on screen, like
// Discourse's screen tracker, and reports the floors read and the time spent in batches; see
// design §8.9. Guests, whose `initial` is undefined, aren't tracked.
export function useReading(threadId: number, initial: Ranges | undefined) {
  const [state, setState] = useState({ threadId, initial, read: floorSet(initial) });
  // A new load of the same thread adds what the server knows by now.
  if (threadId !== state.threadId || initial !== state.initial) {
    const read = floorSet(initial);
    if (threadId === state.threadId) for (const f of state.read) read.add(f);
    setState({ threadId, initial, read });
  }

  // Starts over with each load, from what the server knows.
  useEffect(() => {
    if (initial === undefined) return undefined;
    const counted = floorSet(initial);
    const shownMs = new Map<number, number>();
    let unsent = new Set<number>();
    let unsentMs = 0;
    let lastActive = Date.now();
    let lastSent = Date.now();

    function send() {
      const seconds = Math.floor(unsentMs / 1000);
      if (unsent.size === 0 && seconds === 0) return undefined;
      const floors = rangesOf(unsent);
      unsent = new Set();
      unsentMs -= seconds * 1000;
      lastSent = Date.now();
      // Kept alive so it still goes out when the page is closing.
      return browserApi.threads[":id"].read.$post(
        { param: { id: String(threadId) }, json: { floors, seconds } },
        { init: { keepalive: true } },
      );
    }

    function tick() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActive < IDLE_MS) unsentMs += TICK_MS;
      const done: number[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("[data-floor]")) {
        const floor = Number(el.dataset.floor);
        if (counted.has(floor)) continue;
        const { top, bottom } = el.getBoundingClientRect();
        const shown = Math.min(bottom, innerHeight) - Math.max(top, HEADER_PX);
        // Half of the floor, or half of the window for a floor taller than that.
        if (shown < Math.min(bottom - top, innerHeight - HEADER_PX) / 2) continue;
        const ms = (shownMs.get(floor) ?? 0) + TICK_MS;
        shownMs.set(floor, ms);
        if (ms < READ_MS) continue;
        counted.add(floor);
        unsent.add(floor);
        done.push(floor);
      }
      if (done.length > 0) {
        readHere.set(threadId, Math.max(readHere.get(threadId) ?? 0, ...done));
        setState((s) => ({ ...s, read: new Set([...s.read, ...done]) }));
      }
      if (Date.now() - lastSent >= REPORT_MS) void send();
    }

    function onActive() {
      lastActive = Date.now();
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") void send();
    }

    flush = send;
    const timer = setInterval(tick, TICK_MS);
    addEventListener("scroll", onActive, { passive: true });
    addEventListener("keydown", onActive);
    document.addEventListener("visibilitychange", onVisibility);
    addEventListener("pagehide", send);
    return () => {
      clearInterval(timer);
      removeEventListener("scroll", onActive);
      removeEventListener("keydown", onActive);
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("pagehide", send);
      flush = undefined;
      void send();
    };
  }, [threadId, initial]);

  return initial === undefined ? null : state.read;
}
