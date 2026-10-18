import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Maximize,
  X,
  ZoomIn,
  ZoomOut,
} from "~/components/icons";
import { Button } from "~/components/ui/button";

// An image of a post: what it shows on the page, the large copy, and its description.
export type ViewerImage = { src: string; href: string; alt: string };

const MAX_SCALE = 8;
// How far a finger moves before it's a drag rather than a tap, and a swipe to the next image.
const DRAG = 6;
const SWIPE = 60;

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };

// The images of a post, full screen: the wheel, a pinch, the buttons or a double tap zoom in
// around where they point; dragging moves a zoomed image; arrows, the keys or a swipe go through
// the post's images. Shows the page's copy until the large one has loaded.
export function ImageViewer({
  images,
  start,
  onClose,
}: {
  images: ViewerImage[];
  start: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(start);
  const [view, setView] = useState(FIT);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    view: View;
    moved: boolean;
    spread: number;
    startX: number;
    onImage: boolean;
  } | null>(null);
  const lastTap = useRef(0);
  // Set by a tap on the dark; the viewer closes on the click that follows, as closing sooner leaves
  // that click to the page below, where it can open an image again.
  const closing = useRef(false);
  const image = images[index];

  useEffect(() => dialog.current?.showModal(), []);

  // The large copy, swapped in once it has loaded.
  useEffect(() => {
    const large = new Image();
    large.addEventListener("load", () => setLoaded(image.href));
    large.src = image.href;
  }, [image.href]);

  // Zooms to `scale`, keeping the point at (cx, cy) on the screen where it is.
  function zoomAt(scale: number, cx: number, cy: number) {
    setView((v) => {
      const box = stage.current?.getBoundingClientRect();
      const next = Math.min(Math.max(scale, 1), MAX_SCALE);
      if (!box || next === 1) return FIT;
      // From the stage's center, which the image is scaled around.
      const px = cx - box.left - box.width / 2;
      const py = cy - box.top - box.height / 2;
      const ratio = next / v.scale;
      return { scale: next, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
    });
  }

  function zoomBy(factor: number) {
    const box = stage.current?.getBoundingClientRect();
    if (box) zoomAt(view.scale * factor, box.left + box.width / 2, box.top + box.height / 2);
  }

  function go(step: number) {
    setIndex((i) => (i + step + images.length) % images.length);
    setView(FIT);
  }

  // The wheel zooms rather than scrolls; React's wheel handler can't stop the scrolling.
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(view.scale * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  function onDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Its target before the capture, which sends the rest of the pointer's events to the stage.
    const onImage = e.target instanceof HTMLImageElement;
    gesture.current = { view, moved: false, spread: spread(), startX: e.clientX, onImage };
    closing.current = false;
    setDragging(true);
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const was = pointers.current.get(e.pointerId);
    const g = gesture.current;
    if (!was || !g) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      g.moved = true;
      const [a, b] = [...pointers.current.values()];
      zoomAt((g.view.scale * spread()) / g.spread, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (Math.abs(e.clientX - g.startX) > DRAG) g.moved = true;
    if (view.scale > 1) {
      setView((v) => ({ ...v, x: v.x + e.clientX - was.x, y: v.y + e.clientY - was.y }));
    }
  }

  function onUp(e: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0 || !g) return;
    gesture.current = null;
    setDragging(false);
    const dx = e.clientX - g.startX;
    if (view.scale === 1 && images.length > 1 && Math.abs(dx) > SWIPE) return go(dx < 0 ? 1 : -1);
    if (g.moved) return;
    // A tap: twice in a row zooms in or back; once on the dark around the image closes.
    if (e.timeStamp - lastTap.current < 300) {
      lastTap.current = 0;
      zoomAt(view.scale > 1 ? 1 : 2.5, e.clientX, e.clientY);
    } else {
      lastTap.current = e.timeStamp;
      closing.current = !g.onImage;
    }
  }

  function spread() {
    if (pointers.current.size < 2) return 1;
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  return (
    <dialog
      ref={dialog}
      aria-label="查看图片"
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" && images.length > 1) go(-1);
        if (e.key === "ArrowRight" && images.length > 1) go(1);
      }}
      className="m-0 h-dvh max-h-none w-dvw max-w-none bg-black/95 p-0 text-white backdrop:bg-transparent open:animate-in open:fade-in"
    >
      <div
        ref={stage}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={() => {
          if (closing.current) onClose();
        }}
        role="presentation"
        className="flex h-full w-full touch-none items-center justify-center overflow-hidden select-none"
      >
        <img
          key={image.href}
          src={loaded === image.href ? image.href : image.src}
          alt={image.alt}
          draggable={false}
          className="max-h-full max-w-full animate-in zoom-in-95 fade-in"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: dragging ? "none" : "transform 200ms ease-out",
            cursor: view.scale > 1 ? "grab" : "zoom-in",
          }}
        />
      </div>

      <div className="absolute inset-x-0 top-0 flex items-center gap-1 bg-gradient-to-b from-black/60 to-transparent p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="mr-auto px-2 text-sm text-white/80 tabular-nums">
          {images.length > 1 && `${index + 1} / ${images.length}`}
        </span>
        <span className="w-12 text-center text-xs text-white/70 tabular-nums">
          {Math.round(view.scale * 100)}%
        </span>
        <ToolButton label="缩小" onClick={() => zoomBy(1 / 1.5)}>
          <ZoomOut />
        </ToolButton>
        <ToolButton label="放大" onClick={() => zoomBy(1.5)}>
          <ZoomIn />
        </ToolButton>
        <ToolButton label="适应屏幕" onClick={() => setView(FIT)}>
          <Maximize />
        </ToolButton>
        <a
          href={image.href}
          target="_blank"
          rel="noopener"
          aria-label="打开原图"
          title="打开原图"
          className="flex size-8 items-center justify-center rounded-lg hover:bg-white/15"
        >
          <ExternalLink className="size-4" />
        </a>
        <ToolButton label="关闭" onClick={onClose}>
          <X />
        </ToolButton>
      </div>

      {images.length > 1 &&
        (
          [
            { step: -1, label: "上一张", Icon: ChevronLeft, side: "left-3" },
            { step: 1, label: "下一张", Icon: ChevronRight, side: "right-3" },
          ] as const
        ).map(({ step, label, Icon, side }) => (
          <Button
            key={step}
            variant="ghost"
            size="icon-lg"
            aria-label={label}
            onClick={() => go(step)}
            className={`absolute top-1/2 ${side} -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white max-sm:hidden`}
          >
            <Icon />
          </Button>
        ))}
    </dialog>
  );
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="text-white hover:bg-white/15 hover:text-white"
    >
      {children}
    </Button>
  );
}
