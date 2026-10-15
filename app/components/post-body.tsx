import { useEffect, useRef, useState } from "react";
import { useDismiss } from "~/components/disclosure";
import { ImageViewer, type ViewerImage } from "~/components/image-viewer";
import { CardPanel } from "~/components/user-card";

const MENTION = /^\/u\/(\d+)$/;

// The card's width, w-72.
const CARD_REM = 18;

// A post's rendered HTML. A mention opens the person's card, as their avatar does, and an image
// opens the viewer; with a modifier key, or before the page's script runs, they stay links.
export function PostBody({ html, className }: { html: string; className?: string }) {
  const area = useRef<HTMLDivElement>(null);
  const cardRoot = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ id: number; top: number; left: number } | null>(null);
  const [viewing, setViewing] = useState<{ images: ViewerImage[]; start: number } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useDismiss(card !== null, () => setCard(null), cardRoot);

  function onClick(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target instanceof Element ? e.target.closest("a") : null;
    const box = area.current?.getBoundingClientRect();
    if (!link || !box || !body.current) return;

    const mention = link.classList.contains("mention")
      ? MENTION.exec(link.getAttribute("href") ?? "")
      : null;
    if (mention) {
      e.preventDefault();
      const at = link.getBoundingClientRect();
      const width = CARD_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
      const left = Math.max(0, Math.min(at.left - box.left, box.width - width));
      setCard({ id: Number(mention[1]), top: at.bottom - box.top + 6, left });
      return;
    }

    // Only images uploaded here are shown, each inside a link to its large copy.
    const shown = [...body.current.querySelectorAll("a")].flatMap((a) =>
      a.firstElementChild instanceof HTMLImageElement ? [{ a, img: a.firstElementChild }] : [],
    );
    const start = shown.findIndex((s) => s.a === link);
    if (start === -1) return;
    e.preventDefault();
    setViewing({
      images: shown.map(({ a, img }) => ({ src: img.src, href: a.href, alt: img.alt })),
      start,
    });
  }

  // On the links' own clicks, which the keyboard gives them too.
  useEffect(() => {
    const element = body.current;
    element?.addEventListener("click", onClick);
    return () => element?.removeEventListener("click", onClick);
  });

  return (
    <div ref={area} className="relative">
      <div ref={body} className={className} dangerouslySetInnerHTML={{ __html: html }} />
      {card && (
        <div ref={cardRoot} className="absolute z-50" style={{ top: card.top, left: card.left }}>
          <CardPanel key={card.id} id={card.id} />
        </div>
      )}
      {viewing && <ImageViewer {...viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
