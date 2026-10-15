import { CircleCheck } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { PostItem } from "~/api-types";
import { useDismiss } from "~/components/disclosure";
import { UserAvatar } from "~/components/user-avatar";
import { stamp } from "~/time";

// Up to this many floors a plain list fits beside the posts; beyond it, a timeline scrubber.
const LIST_MAX = 12;

// Floors at or above this line of the viewport count as read past (header plus some air).
const READ_LINE = 120;

// What the floor navigation knows: the floors on the page, how many there are in all, which one
// is being read, and how to get to another.
export type Floors = {
  posts: PostItem[];
  total: number;
  current: number;
  jump: (floor: number) => void;
  // The times at both ends of the timeline.
  first: string;
  last: string;
  now: number;
};

// `onJump` lets a popup close once the reader has picked a floor.
export function FloorNav({ floors, onJump }: { floors: Floors; onJump?: () => void }) {
  // With this few floors they are all on the page.
  if (floors.total <= LIST_MAX) {
    return (
      <div className="flex flex-col gap-0.5">
        {floors.posts.map((p) => (
          <a
            key={p.id}
            href={`?floor=${p.floor}`}
            onClick={(e) => {
              e.preventDefault();
              floors.jump(p.floor);
              onJump?.();
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
          >
            <span className="w-7 shrink-0 text-muted-foreground tabular-nums">#{p.floor}</span>
            <UserAvatar user={p.author} thread={p.thread_id} className="size-5 text-2xs" />
            <span className="truncate" title={p.author.display_name}>
              {p.author.display_name}
            </span>
            {p.accepted && <CircleCheck className="ml-auto size-3.5 text-success" />}
          </a>
        ))}
      </div>
    );
  }
  return <FloorTimeline floors={floors} onJump={onJump} />;
}

// Below the width that has room for the side column: a floating "3 / 52" that opens the same
// navigation above it.
export function FloorProgress({ floors }: { floors: Floors }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root);
  return (
    <div ref={root} className="fixed right-4 bottom-6 z-20 xl:hidden">
      {open && (
        <nav
          aria-label="楼层"
          className="absolute right-0 bottom-full mb-2 w-56 rounded-2xl border bg-card p-3 text-meta shadow-lg animate-in fade-in zoom-in-95"
        >
          <FloorNav floors={floors} onJump={() => setOpen(false)} />
        </nav>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={`第 ${floors.current} 楼，共 ${floors.total} 楼，打开楼层导航`}
        onClick={() => setOpen(!open)}
        className="rounded-full border bg-card/95 px-4 py-2 text-meta font-medium tabular-nums shadow-lg backdrop-blur"
      >
        {floors.current} / {floors.total}
      </button>
    </div>
  );
}

// The last floor whose top has scrolled past the reading line; the last one at the bottom.
export function useCurrentFloor(start: number) {
  const [current, setCurrent] = useState(start);
  // Measured before paint, so a navigation opened mid-thread doesn't flash the wrong floor.
  useLayoutEffect(() => {
    let frame = 0;
    function update() {
      frame = 0;
      const floors = document.querySelectorAll<HTMLElement>("[data-floor]");
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      const passed = atBottom
        ? floors[floors.length - 1]
        : Array.from(floors).findLast((el) => el.getBoundingClientRect().top < READ_LINE);
      // Above the first loaded floor, that floor is the one being read.
      setCurrent(Number((passed ?? floors[0]).dataset.floor ?? start));
    }
    function onScroll() {
      frame ||= requestAnimationFrame(update);
    }
    update();
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [start]);
  return [current, setCurrent] as const;
}

function FloorTimeline({ floors, onJump }: { floors: Floors; onJump?: () => void }) {
  const { total, current } = floors;
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? current;

  function go(floor: number) {
    floors.jump(floor);
    onJump?.();
  }

  // The range moves the handle while it is dragged or keyed; the page follows on release.
  function release() {
    if (dragging === null) return;
    go(dragging);
    setDragging(null);
  }

  const offset = (shown - 1) / (total - 1);
  const at = floors.posts.find((p) => p.floor === shown);
  return (
    <div className="flex flex-col gap-2 text-meta select-none">
      <button
        type="button"
        onClick={() => go(1)}
        className="self-start text-muted-foreground hover:text-foreground"
      >
        {floors.first}
      </button>
      <div className="relative h-[min(16rem,40svh)]">
        {/* Vertical, so the first floor is at the top. Invisible: the handle below draws it. */}
        <input
          type="range"
          min={1}
          max={total}
          value={shown}
          aria-label="楼层"
          aria-valuetext={`第 ${shown} 楼，共 ${total} 楼`}
          onChange={(e) => setDragging(e.currentTarget.valueAsNumber)}
          onPointerUp={release}
          onKeyUp={release}
          className="peer absolute inset-0 size-full cursor-pointer opacity-0 [writing-mode:vertical-lr]"
        />
        <div className="pointer-events-none absolute inset-y-0 left-1 w-0.5 rounded-full bg-border" />
        <div
          className="pointer-events-none absolute inset-x-0 flex h-16 items-center gap-3 rounded-md peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-ring"
          style={{ top: `calc(${offset} * (100% - 4rem))` }}
        >
          <div className="h-full w-1.5 shrink-0 rounded-full bg-brand" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-foreground tabular-nums">
              {shown} / {total}
            </div>
            {/* Who wrote it and when, once that floor is on the page. */}
            {at && (
              <>
                <div className="mt-1 flex items-center gap-1.5">
                  <UserAvatar user={at.author} thread={at.thread_id} className="size-5 text-2xs" />
                  <span className="truncate text-foreground/80">{at.author.display_name}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {stamp(at.created_at, floors.now)}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => go(total)}
        className="self-start text-muted-foreground hover:text-foreground"
      >
        {floors.last}
      </button>
    </div>
  );
}
