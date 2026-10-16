import type { CSSProperties, ReactNode } from "react";
import { cn } from "cn";
import type { BackgroundPreset } from "../../server/modules/users/customization.ts";

// What a card's top and a page's banner show behind them (design §8.16): a preset drawn here, or
// the person's own picture cut for the place. Presets are a few layers of gradients and small
// inline SVG tiles; only their transforms and opacity move (app.css, .look-motion), and only once
// their moving version is bought.

export type Background =
  { preset: BackgroundPreset; moving: boolean } | { card_url: string; profile_url: string };

export function Backdrop({
  background,
  place,
  className,
}: {
  background: Background;
  place: "card" | "profile";
  className?: string;
}) {
  return (
    <div
      // Starting over when it stops moving, as it stands still for others.
      key={"preset" in background ? String(background.moving) : "picture"}
      aria-hidden
      className={cn(
        "absolute inset-0 overflow-hidden",
        "preset" in background && !background.moving && "[--play:paused]",
        className,
      )}
    >
      {"preset" in background ? (
        PRESETS[background.preset]()
      ) : (
        <img
          src={place === "card" ? background.card_url : background.profile_url}
          alt=""
          decoding="async"
          className="size-full object-cover"
        />
      )}
    </div>
  );
}

function tile(body: string, width: number, height: number, stretch = false) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'${stretch ? " preserveAspectRatio='none'" : ""}>${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const layer = "absolute inset-0";
const moving = "look-motion absolute";

// Stars at fixed spots, so a tile is the same wherever it shows.
function starTile(seed: number, width: number, height: number, count: number) {
  let n = seed;
  const next = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  const stars = Array.from({ length: count }, () => {
    const r = (0.5 + next() * 1.1).toFixed(2);
    const o = (0.45 + next() * 0.55).toFixed(2);
    return `<circle cx='${(next() * width).toFixed(1)}' cy='${(next() * height).toFixed(1)}' r='${r}' fill='#fff' opacity='${o}'/>`;
  });
  return tile(stars.join(""), width, height);
}

const STARS = [
  { image: starTile(7, 240, 120, 14), size: "240px 120px", duration: "3.6s", delay: "0s" },
  { image: starTile(23, 330, 160, 12), size: "330px 160px", duration: "5.2s", delay: "-2s" },
  { image: starTile(61, 410, 190, 10), size: "410px 190px", duration: "7s", delay: "-4s" },
];

function Stars({ dim = 1 }: { dim?: number }) {
  return STARS.map((s) => (
    <div
      key={s.size}
      className={cn(moving, "inset-0 animate-look-twinkle")}
      style={{
        backgroundImage: s.image,
        backgroundSize: s.size,
        opacity: dim,
        animationDuration: s.duration,
        animationDelay: s.delay,
      }}
    />
  ));
}

function blob(color: string): CSSProperties {
  return { background: `radial-gradient(closest-side, ${color}, transparent)` };
}

function Mist() {
  return (
    <>
      <div
        className={layer}
        style={{ background: "linear-gradient(135deg, #d6eee8 0%, #f4efe6 52%, #fbdfca 100%)" }}
      />
      <div
        className={cn(moving, "-top-1/2 -left-1/4 aspect-square w-3/4 animate-look-drift")}
        style={blob("rgb(43 122 107 / 0.3)")}
      />
      <div
        className={cn(moving, "-right-1/4 -bottom-1/2 aspect-square w-3/4 animate-look-drift")}
        style={{
          ...blob("rgb(239 159 112 / 0.38)"),
          animationDuration: "21s",
          animationDirection: "alternate-reverse",
        }}
      />
      <div
        className={cn(moving, "top-[10%] left-[30%] aspect-square w-1/2 animate-look-drift")}
        style={{ ...blob("rgb(255 255 255 / 0.65)"), animationDuration: "12s" }}
      />
    </>
  );
}

const GRAIN = tile(
  "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.45 0 0 0 0 0.3 0 0 0 0 0.18 0 0 0 0.09 0'/></filter><rect width='160' height='160' filter='url(#g)'/>",
  160,
  160,
);

function Paper() {
  return (
    <>
      <div className={layer} style={{ background: "#fbf6ec" }} />
      <div
        className={layer}
        style={{
          backgroundImage: `linear-gradient(to right, transparent 9%, rgb(239 159 112 / 0.45) 9%, rgb(239 159 112 / 0.45) calc(9% + 1px), transparent calc(9% + 1px)), repeating-linear-gradient(to bottom, transparent 0 1.45rem, rgb(43 122 107 / 0.1) 1.45rem calc(1.45rem + 1px)), ${GRAIN}`,
          backgroundSize: "auto, auto, 160px",
        }}
      />
      {/* A pale sun pressed into the corner, like a seal. */}
      <div
        className="absolute top-[12%] right-[7%] aspect-square w-[16%] rounded-full border-2 border-[#ef9f70]/40"
        style={blob("rgb(239 159 112 / 0.28)")}
      />
    </>
  );
}

function wave(color: string) {
  // Two swells a tile, level at both ends, so tiles meet without a seam.
  return tile(
    `<path fill='${color}' d='M0 30 Q50 6 100 30 T200 30 T300 30 T400 30 V60 H0Z'/>`,
    400,
    60,
    true,
  );
}

const WAVES = [
  { color: "#a6dbd0", height: "54%", duration: "17s", reverse: false },
  { color: "#5aae9e", height: "42%", duration: "11s", reverse: true },
  { color: "#2b7a6b", height: "31%", duration: "8s", reverse: false },
];

function Waves() {
  return (
    <>
      <div
        className={layer}
        style={{ background: "linear-gradient(to bottom, #f4fbf9 0%, #d8f0ea 55%, #bfe3da 100%)" }}
      />
      <div
        className="absolute top-[14%] right-[12%] aspect-square w-[11%] rounded-full"
        style={{ background: "radial-gradient(closest-side, #ffd9b8, #ef9f70 70%, transparent)" }}
      />
      {/* Twice as wide as the box, with one tile per box width: sliding by half loops. */}
      {WAVES.map((w) => (
        <div
          key={w.color}
          className={cn(moving, "bottom-0 left-0 w-[200%] animate-look-slide")}
          style={{
            height: w.height,
            backgroundImage: wave(w.color),
            backgroundSize: "50% 100%",
            animationDuration: w.duration,
            animationDirection: w.reverse ? "reverse" : "normal",
          }}
        />
      ))}
    </>
  );
}

// Two hills and the hole between them, the 鼠洞 the sun rises from.
const HILLS = tile(
  "<path fill='#6f9c8d' d='M0 52 C70 22 150 26 210 44 S340 24 400 38 V100 H0Z'/><path fill='#2f6156' d='M0 74 C90 50 160 54 200 62 C240 54 310 50 400 72 V100 H0Z'/><ellipse cx='200' cy='80' rx='30' ry='13' fill='#17302b'/>",
  400,
  100,
  true,
);

function Sunrise() {
  return (
    <>
      <div
        className={layer}
        style={{
          background:
            "linear-gradient(to bottom, #c6d2ea 0%, #f0c8b6 46%, #fadfc3 74%, #fdeedb 100%)",
        }}
      />
      <div className="absolute top-[78%] left-1/2 aspect-square w-[150%] -translate-x-1/2 -translate-y-1/2">
        <div
          className={cn(moving, "inset-0 animate-look-spin rounded-full")}
          style={{
            background:
              "repeating-conic-gradient(rgb(255 255 255 / 0.3) 0 5deg, transparent 5deg 15deg)",
            maskImage: "radial-gradient(closest-side, #000 12%, transparent 62%)",
          }}
        />
      </div>
      <div className="absolute top-[70%] left-1/2 aspect-square w-[44%] -translate-x-1/2 -translate-y-1/2">
        <div
          className={cn(moving, "inset-0 animate-look-glow")}
          style={blob("rgb(255 205 140 / 0.85)")}
        />
      </div>
      <div className="absolute top-[64%] left-1/2 aspect-square w-[15%] -translate-x-1/2 -translate-y-1/2">
        <div
          className={cn(moving, "inset-0 animate-look-bob rounded-full")}
          style={{
            background: "radial-gradient(circle at 50% 42%, #fff8e6, #ffd598 52%, #f5a466)",
          }}
        />
      </div>
      <div
        className="absolute inset-x-0 bottom-0 h-[42%]"
        style={{ backgroundImage: HILLS, backgroundSize: "100% 100%" }}
      />
    </>
  );
}

const MOON = tile(
  "<mask id='m'><rect width='40' height='40' fill='#fff'/><circle cx='27' cy='14' r='12'/></mask><circle cx='20' cy='20' r='17' fill='#f6efd6' opacity='0.12'/><circle cx='20' cy='20' r='12' fill='#f6efd6' mask='url(#m)'/>",
  40,
  40,
);

function Night() {
  return (
    <>
      <div
        className={layer}
        style={{ background: "linear-gradient(to bottom, #0b1626 0%, #14283e 55%, #26445c 100%)" }}
      />
      <div
        className={layer}
        style={{
          background:
            "radial-gradient(ellipse at 50% 125%, rgb(124 196 184 / 0.4), transparent 60%)",
        }}
      />
      <Stars />
      <div
        className="absolute top-[12%] right-[9%] aspect-square w-[9%]"
        style={{ backgroundImage: MOON, backgroundSize: "100% 100%" }}
      />
      <div
        className={cn(moving, "top-[22%] right-[2%] h-px w-1/4 animate-look-shoot")}
        style={{ background: "linear-gradient(to left, #fff, transparent)" }}
      />
    </>
  );
}

const RIDGE = tile(
  "<path fill='#05151b' d='M0 70 L40 52 L75 64 L120 38 L160 58 L205 44 L250 62 L300 36 L345 56 L400 46 V100 H0Z'/>",
  400,
  100,
  true,
);

const RIBBONS = [
  { color: "rgb(94 224 192 / 0.55)", top: "18%", duration: "11s", delay: "0s" },
  { color: "rgb(150 236 150 / 0.38)", top: "30%", duration: "15s", delay: "-5s" },
  { color: "rgb(150 120 240 / 0.32)", top: "4%", duration: "19s", delay: "-9s" },
];

function Aurora() {
  return (
    <>
      <div
        className={layer}
        style={{ background: "linear-gradient(to bottom, #061922 0%, #0b2e35 60%, #11423f 100%)" }}
      />
      <Stars dim={0.5} />
      {RIBBONS.map((r) => (
        <div
          key={r.color}
          className={cn(moving, "-left-1/4 h-[62%] w-[150%] animate-look-sway")}
          style={{
            top: r.top,
            background: `radial-gradient(ellipse 50% 32% at 50% 50%, ${r.color}, transparent 72%)`,
            animationDuration: r.duration,
            animationDelay: r.delay,
          }}
        />
      ))}
      <div
        className="absolute inset-x-0 bottom-0 h-[30%]"
        style={{ backgroundImage: RIDGE, backgroundSize: "100% 100%" }}
      />
    </>
  );
}

function Shimmer() {
  return (
    <>
      <div
        className={layer}
        style={{
          background:
            "repeating-linear-gradient(120deg, rgb(255 255 255 / 0.045) 0 1px, transparent 1px 12px), linear-gradient(120deg, #0f3530 0%, #1f5c51 46%, #133e38 100%)",
        }}
      />
      <div
        className={layer}
        style={{
          background:
            "radial-gradient(ellipse at 100% 100%, rgb(239 159 112 / 0.32), transparent 55%)",
        }}
      />
      <div
        className={cn(moving, "-inset-y-1/4 left-0 w-[34%] animate-look-sweep")}
        style={{
          background:
            "linear-gradient(90deg, transparent, rgb(255 255 255 / 0.18) 42%, rgb(255 238 214 / 0.42) 50%, rgb(255 255 255 / 0.18) 58%, transparent)",
        }}
      />
      <div
        className={cn(moving, "-inset-y-1/4 left-0 w-[12%] animate-look-sweep")}
        style={{
          background: "linear-gradient(90deg, transparent, rgb(239 159 112 / 0.35), transparent)",
          animationDelay: "-2.4s",
        }}
      />
    </>
  );
}

// Columns as tall as the box, each carrying a mote up from the bottom.
const MOTES = Array.from({ length: 14 }, (_, i) => ({
  left: `${(i * 37 + 5) % 96}%`,
  size: `${0.18 + ((i * 7) % 5) * 0.06}rem`,
  duration: `${7 + ((i * 5) % 6)}s`,
  delay: `${-((i * 13) % 11)}s`,
}));

function Gilded() {
  return (
    <>
      <div
        className={layer}
        style={{
          background:
            "radial-gradient(ellipse 85% 95% at 50% 115%, #84561a 0%, #3c260a 46%, #150d05 100%)",
        }}
      />
      <div
        className={layer}
        style={{
          background:
            "linear-gradient(115deg, transparent 30%, rgb(233 184 96 / 0.16) 48%, transparent 66%)",
        }}
      />
      {MOTES.map((m) => (
        <div
          key={m.left}
          className={cn(moving, "inset-y-0 w-2 animate-look-rise")}
          style={{ left: m.left, animationDuration: m.duration, animationDelay: m.delay }}
        >
          <div
            className="absolute bottom-0 left-1/2 aspect-square -translate-x-1/2 rounded-full"
            style={{
              width: m.size,
              background: "radial-gradient(closest-side, #fff1c2, #e9b860 55%, transparent)",
            }}
          />
        </div>
      ))}
      <div
        className={cn(moving, "top-[18%] left-[16%] aspect-square w-[9%] animate-look-twinkle")}
        style={{ ...blob("rgb(255 214 140 / 0.45)"), animationDuration: "6s" }}
      />
      <div
        className={cn(moving, "top-[46%] right-[14%] aspect-square w-[6%] animate-look-twinkle")}
        style={{
          ...blob("rgb(255 214 140 / 0.4)"),
          animationDuration: "8s",
          animationDelay: "-3s",
        }}
      />
    </>
  );
}

const PRESETS: Record<BackgroundPreset, () => ReactNode> = {
  mist: Mist,
  paper: Paper,
  waves: Waves,
  sunrise: Sunrise,
  stars: Night,
  aurora: Aurora,
  shimmer: Shimmer,
  gilded: Gilded,
};
