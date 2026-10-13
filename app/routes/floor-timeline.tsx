import { CircleCheck } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "~/components/disclosure";
import type { Post } from "~/draft-data";

// Up to this many floors a plain list fits beside the posts; beyond it, a timeline scrubber.
const LIST_MAX = 12;

// Floors at or above this line of the viewport count as read past (header plus some air).
const READ_LINE = 120;

// `onJump` lets a popup close once the reader has picked a floor.
export function FloorNav({ posts, onJump }: { posts: Post[]; onJump?: () => void }) {
  if (posts.length <= LIST_MAX) {
    return (
      <div className="flex flex-col gap-0.5">
        {posts.map((p) => (
          <a
            key={p.id}
            href={`#floor-${p.floor}`}
            onClick={onJump}
            className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
          >
            <span className="w-7 text-muted-foreground tabular-nums">#{p.floor}</span>
            <span className="truncate">{p.author.name}</span>
            {p.accepted && <CircleCheck className="ml-auto size-3.5 text-success" />}
          </a>
        ))}
      </div>
    );
  }
  return <FloorTimeline posts={posts} onJump={onJump} />;
}

// Below the width that has room for the side column: a floating "3 / 52" that opens the same
// navigation above it.
export function FloorProgress({ posts }: { posts: Post[] }) {
  const [open, setOpen] = useState(false);
  const [current] = useCurrentFloor();
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root);
  return (
    <div ref={root} className="fixed right-4 bottom-6 z-20 xl:hidden">
      {open && (
        <nav
          aria-label="楼层"
          className="absolute right-0 bottom-full mb-2 w-56 rounded-2xl border bg-card p-3 text-meta shadow-lg"
        >
          <FloorNav posts={posts} onJump={() => setOpen(false)} />
        </nav>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={`第 ${current} 楼，共 ${posts.length} 楼，打开楼层导航`}
        onClick={() => setOpen(!open)}
        className="rounded-full border bg-card/95 px-4 py-2 text-meta font-medium tabular-nums shadow-lg backdrop-blur"
      >
        {current} / {posts.length}
      </button>
    </div>
  );
}

// The last floor whose top has scrolled past the reading line; the last one at the bottom.
function useCurrentFloor() {
  const [current, setCurrent] = useState(1);
  // Measured before paint, so a navigation opened mid-thread doesn't flash floor 1.
  useLayoutEffect(() => {
    let frame = 0;
    function update() {
      frame = 0;
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      const floors = document.querySelectorAll<HTMLElement>("[data-floor]");
      const passed = atBottom
        ? floors[floors.length - 1]
        : Array.from(floors).findLast((el) => el.getBoundingClientRect().top < READ_LINE);
      setCurrent(Number(passed?.dataset.floor ?? 1));
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
  }, []);
  return [current, setCurrent] as const;
}

function jump(floor: number) {
  document.getElementById(`floor-${floor}`)?.scrollIntoView();
}

function FloorTimeline({ posts, onJump }: { posts: Post[]; onJump?: () => void }) {
  const total = posts.length;
  const [current, setCurrent] = useCurrentFloor();
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? current;

  function go(floor: number) {
    setCurrent(floor);
    jump(floor);
    onJump?.();
  }

  // The range moves the handle while it is dragged or keyed; the page follows on release.
  function release() {
    if (dragging === null) return;
    go(dragging);
    setDragging(null);
  }

  const offset = (shown - 1) / (total - 1);
  return (
    <div className="flex flex-col gap-2 text-meta select-none">
      <button
        type="button"
        onClick={() => go(1)}
        className="self-start text-muted-foreground hover:text-foreground"
      >
        {posts[0]?.time}
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
          className="pointer-events-none absolute left-0 flex h-12 items-center gap-3 rounded-md peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-ring"
          style={{ top: `calc(${offset} * (100% - 3rem))` }}
        >
          <div className="h-full w-1.5 rounded-full bg-brand" />
          <div>
            <div className="font-semibold text-foreground tabular-nums">
              {shown} / {total}
            </div>
            <div className="text-xs text-muted-foreground">
              {posts.find((p) => p.floor === shown)?.time}
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => go(total)}
        className="self-start text-muted-foreground hover:text-foreground"
      >
        {posts.at(-1)?.time}
      </button>
    </div>
  );
}
