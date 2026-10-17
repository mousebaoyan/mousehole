import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { BACKGROUND_CROPS } from "../../server/modules/users/customization.ts";

// Cutting an uploaded background square and wide (design §8.16), each on its own: dragged to move,
// pinched, scrolled or slid to zoom.

const PLACES = ["card", "profile"] as const;
type Place = (typeof PLACES)[number];

export type Region = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };
// Where the cut is centred, in the picture's pixels, and how far in it is zoomed.
type View = { x: number; y: number; zoom: number };

const MAX_ZOOM = 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// At zoom 1 the cut is as large as the picture allows; it never leaves the picture.
function regionOf(view: View, size: Size, ratio: number): Region {
  const width = Math.min(size.width, size.height * ratio) / view.zoom;
  const height = width / ratio;
  return {
    left: clamp(view.x - width / 2, 0, size.width - width),
    top: clamp(view.y - height / 2, 0, size.height - height),
    width,
    height,
  };
}

// Whole pixels, still inside the picture.
function rounded(r: Region): Region {
  const left = Math.floor(r.left);
  const top = Math.floor(r.top);
  return { left, top, width: Math.floor(r.width), height: Math.floor(r.height) };
}

export function BackgroundCropper({
  url,
  busy,
  onCancel,
  onDone,
}: {
  url: string;
  busy: boolean;
  onCancel: () => void;
  onDone: (regions: Record<Place, Region>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [size, setSize] = useState<Size | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [place, setPlace] = useState<Place>("card");
  const [views, setViews] = useState<Record<Place, View> | null>(null);
  const ratio = BACKGROUND_CROPS[place].ratio;

  useEffect(() => dialog.current?.showModal(), []);

  // The frame's width on the screen, which turns screen pixels into the picture's.
  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setFrameWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const view = views?.[place];
  const region = view && size ? regionOf(view, size, ratio) : null;
  const scale = region ? frameWidth / region.width : 0;

  // Moves and zooms keep the view where its region is, so a cut stopped at an edge moves away
  // from it at once.
  function update(change: (view: View, region: Region) => View) {
    if (!views || !size || !region || !view) return;
    const next = change(view, region);
    const zoom = clamp(next.zoom, 1, MAX_ZOOM);
    const kept = regionOf({ ...next, zoom }, size, ratio);
    setViews({
      ...views,
      [place]: { x: kept.left + kept.width / 2, y: kept.top + kept.height / 2, zoom },
    });
  }

  function zoomBy(factor: number) {
    update((v) => ({ ...v, zoom: v.zoom * factor }));
  }

  // The page behind would scroll with the wheel unless it is stopped, which React's own wheel
  // handler, being passive, can't do.
  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY / 400));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const all = pointers.current;
    const before = all.get(e.pointerId);
    if (!before) return;
    const now = { x: e.clientX, y: e.clientY };
    const other = [...all].find(([id]) => id !== e.pointerId)?.[1];
    if (other) {
      zoomBy(
        Math.hypot(now.x - other.x, now.y - other.y) /
          Math.hypot(before.x - other.x, before.y - other.y),
      );
    } else {
      update((v) => ({
        ...v,
        x: v.x - (now.x - before.x) / scale,
        y: v.y - (now.y - before.y) / scale,
      }));
    }
    all.set(e.pointerId, now);
  }

  function release(e: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
  }

  return (
    <Dialog ref={dialog} onClose={onCancel} className="w-[min(36rem,calc(100%-2rem))]">
      <h2 className="font-semibold">裁剪背景</h2>
      <p className="mt-1 text-meta text-muted-foreground">
        方形用在资料卡和手机上的主页，横版用在宽屏的主页，分别裁剪。拖动调整位置，双指、滚轮或下方的滑块缩放
      </p>
      <fieldset aria-label="裁剪哪一处" className="mt-3 inline-flex rounded-lg bg-secondary p-0.5">
        {PLACES.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={p === place}
            onClick={() => setPlace(p)}
            className="rounded-md px-3 py-1 text-sm text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm"
          >
            {BACKGROUND_CROPS[p].label}
          </button>
        ))}
      </fieldset>
      <div
        ref={frame}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        className="relative mx-auto mt-3 cursor-grab touch-none overflow-hidden rounded-xl bg-muted select-none active:cursor-grabbing"
        // An upright cut no taller than most of the screen.
        style={{ aspectRatio: ratio, width: `min(100%, ${60 * ratio}vh)` }}
      >
        <img
          src={url}
          alt="要裁剪的背景"
          draggable={false}
          onLoad={(e) => {
            const picture = {
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            };
            const centre = { x: picture.width / 2, y: picture.height / 2, zoom: 1 };
            setSize(picture);
            setViews({ card: centre, profile: centre });
          }}
          className="absolute top-0 left-0 max-w-none origin-top-left"
          style={
            region && size
              ? {
                  width: size.width,
                  height: size.height,
                  transform: `scale(${scale}) translate(${-region.left}px, ${-region.top}px)`,
                }
              : { visibility: "hidden" }
          }
        />
      </div>
      <input
        type="range"
        aria-label="缩放"
        min={1}
        max={MAX_ZOOM}
        step={0.01}
        value={view?.zoom ?? 1}
        onChange={(e) => update((v) => ({ ...v, zoom: Number(e.target.value) }))}
        className="mt-3 w-full accent-primary"
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
          取消
        </Button>
        <Button
          type="button"
          disabled={!views || !size || busy}
          onClick={() =>
            views &&
            size &&
            onDone({
              card: rounded(regionOf(views.card, size, BACKGROUND_CROPS.card.ratio)),
              profile: rounded(regionOf(views.profile, size, BACKGROUND_CROPS.profile.ratio)),
            })
          }
        >
          {busy ? "上传中…" : "上传"}
        </Button>
      </div>
    </Dialog>
  );
}
