import { useId } from "react";
import { cn } from "cn";
import type { Frame } from "../../server/modules/users/customization.ts";

// Avatar frames (design §8.16), drawn around an avatar whose circle is (50, 50) r 50, a fifth
// wider than it. Each is one string of SVG written into the page, as icons are; "§" stands for
// the instance's own prefix to its gradients' IDs. Moving parts turn or fade about their own
// box (app.css, .look-motion), and stand still when a container sets --play: paused.

const BOX = "transform-box:fill-box;transform-origin:center";

function moving(animation: string, style = "") {
  return `class='look-motion animate-look-${animation}' style='${BOX};${style}'`;
}

// A four-pointed sparkle.
function sparkle(x: number, y: number, size: number) {
  return `M${x} ${y - size}Q${x} ${y} ${x + size} ${y}Q${x} ${y} ${x} ${y + size}Q${x} ${y} ${x - size} ${y}Q${x} ${y} ${x} ${y - size}Z`;
}

function ring(r: number, stroke: string, width: number, extra = "") {
  return `<circle cx='50' cy='50' r='${r}' fill='none' stroke='${stroke}' stroke-width='${width}' ${extra}/>`;
}

// Something that turns about the avatar's centre: the hidden circle centres its box there.
function turning(body: string, seconds: number) {
  return `<g ${moving("spin", `animation-duration:${seconds}s`)}><circle cx='50' cy='50' r='56' fill='none'/>${body}</g>`;
}

function point(r: number, degrees: number) {
  const a = (degrees * Math.PI) / 180;
  return { x: +(50 + r * Math.sin(a)).toFixed(2), y: +(50 - r * Math.cos(a)).toFixed(2) };
}

// A highlight running round a ring of radius r.
function glint(r: number, seconds: number, color = "#fff", width = 1.6) {
  const end = point(r, 38);
  return turning(
    `<path d='M50 ${50 - r}A${r} ${r} 0 0 1 ${end.x} ${end.y}' fill='none' stroke='${color}' stroke-opacity='.9' stroke-width='${width}' stroke-linecap='round'/>`,
    seconds,
  );
}

const GOLD = `<linearGradient id='§gold' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#fff1b0'/><stop offset='.35' stop-color='#e9b860'/><stop offset='.7' stop-color='#b07a12'/><stop offset='1' stop-color='#f3d77a'/></linearGradient>`;

// Leaves along both sides of a ring, from the bottom up, each pair turned out from the stem.
function branches(r: number, from: number, to: number, count: number, size: number) {
  const leaves: string[] = [];
  for (const side of [1, -1]) {
    for (let i = 0; i < count; i++) {
      const along = from + ((to - from) * i) / (count - 1);
      // Measured from the bottom, round towards the top.
      const { x, y } = point(r, 180 - side * along);
      const tangent = 180 - side * along - side * 90;
      const scale = (size * (1 - (i / count) * 0.3)).toFixed(2);
      for (const tilt of [-34, 34]) {
        leaves.push(
          `<use href='#§leaf' transform='translate(${x} ${y}) rotate(${(tangent - 90 + tilt * side).toFixed(1)}) scale(${scale})'/>`,
        );
      }
    }
  }
  return leaves.join("");
}

// A leaf from its stalk to its tip, along x.
// Both sides of a ring from `from` to `to` degrees up from the bottom.
function stem(r: number, from: number, to: number) {
  const [a, b, c, d] = [
    point(r, 180 - from),
    point(r, 180 - to),
    point(r, 180 + from),
    point(r, 180 + to),
  ];
  return `M${a.x} ${a.y}A${r} ${r} 0 0 0 ${b.x} ${b.y}M${c.x} ${c.y}A${r} ${r} 0 0 1 ${d.x} ${d.y}`;
}

const LEAF = `<path id='§leaf' d='M0 0C3 -3.6 8.5 -4 13 0C8.5 4 3 3.6 0 0Z'/>`;

function flower(x: number, y: number, petal: string, delay: number) {
  const petals = [0, 72, 144, 216, 288]
    .map((a) => {
      const p = {
        x: x + 2.6 * Math.sin((a * Math.PI) / 180),
        y: y - 2.6 * Math.cos((a * Math.PI) / 180),
      };
      return `<circle cx='${p.x.toFixed(2)}' cy='${p.y.toFixed(2)}' r='2.5' fill='${petal}' stroke='#e98aa6' stroke-opacity='.35' stroke-width='.4'/>`;
    })
    .join("");
  return `<g ${moving("swing", `animation-delay:${delay}s`)}>${petals}<circle cx='${x}' cy='${y}' r='1.5' fill='#f6c94c'/></g>`;
}

const CONFETTI = [
  [-5, 18, "#ef9f70", 30],
  [6, 2, "#7cc4b8", -20],
  [96, 10, "#c3b0e6", 45],
  [106, 40, "#f4a7bd", 10],
  [104, 74, "#f6c94c", -35],
  [86, 101, "#7cc4b8", 60],
  [12, 96, "#c3b0e6", -50],
  [-7, 64, "#f6c94c", 20],
  [30, -8, "#f4a7bd", -10],
  [74, -6, "#ef9f70", 25],
];

function confetti(part: number) {
  return CONFETTI.filter((_, i) => i % 2 === part)
    .map(([x, y, color, angle]) =>
      Number(x) % 3 === 0
        ? `<circle cx='${x}' cy='${y}' r='1.3' fill='${color}'/>`
        : `<rect x='${Number(x) - 1.6}' y='${Number(y) - 0.8}' width='3.2' height='1.6' rx='.4' fill='${color}' transform='rotate(${angle} ${x} ${y})'/>`,
    )
    .join("");
}

const ART: Record<Frame, string> = {
  teal:
    `<defs><linearGradient id='§t' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#8fd3c4'/><stop offset='.5' stop-color='#2b7a6b'/><stop offset='1' stop-color='#5fb3a3'/></linearGradient></defs>` +
    ring(53, "url(#§t)", 4) +
    ring(50.4, "#fff", 0.9, "stroke-opacity='.75'") +
    [45, 135, 225, 315]
      .map((a) => point(53, a))
      .map((p) => `<circle cx='${p.x}' cy='${p.y}' r='1.3' fill='#e8fbf6'/>`)
      .join("") +
    glint(53, 7),

  apricot:
    `<defs><linearGradient id='§a' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f6c08f'/><stop offset='1' stop-color='#d9783f'/></linearGradient><radialGradient id='§s'><stop offset='0' stop-color='#fff6e2'/><stop offset='.6' stop-color='#ffc982'/><stop offset='1' stop-color='#ef9f70'/></radialGradient></defs>` +
    ring(54, "url(#§a)", 2.4) +
    ring(50.9, "#fbd9bd", 1.4) +
    `<g ${moving("spin", "animation-duration:14s")}><circle cx='50' cy='-4' r='11' fill='none'/>${[
      0, 45, 90, 135, 180, 225, 270, 315,
    ]
      .map((a) => {
        const r = (a * Math.PI) / 180;
        const [x1, y1, x2, y2] = [
          50 + 7.6 * Math.sin(r),
          -4 - 7.6 * Math.cos(r),
          50 + 10.4 * Math.sin(r),
          -4 - 10.4 * Math.cos(r),
        ].map((v) => v.toFixed(2));
        return `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}' stroke='#f5a466' stroke-width='1.4' stroke-linecap='round'/>`;
      })
      .join("")}</g>` +
    `<circle cx='50' cy='-4' r='6' fill='url(#§s)' stroke='#fff' stroke-width='.8'/>`,

  flow:
    `<defs><linearGradient id='§f' gradientUnits='userSpaceOnUse' x1='50' y1='-3' x2='103' y2='50'><stop offset='0' stop-color='#2b7a6b' stop-opacity='0'/><stop offset='1' stop-color='#2b9a85'/></linearGradient><linearGradient id='§g' gradientUnits='userSpaceOnUse' x1='50' y1='103' x2='-3' y2='50'><stop offset='0' stop-color='#ef9f70' stop-opacity='0'/><stop offset='1' stop-color='#ef8f5a'/></linearGradient></defs>` +
    ring(53, "#2b7a6b", 4.5, "stroke-opacity='.16'") +
    turning(
      `<path d='M50 -3A53 53 0 0 1 103 50' fill='none' stroke='url(#§f)' stroke-width='4.5' stroke-linecap='round'/><path d='M50 103A53 53 0 0 1 -3 50' fill='none' stroke='url(#§g)' stroke-width='4.5' stroke-linecap='round'/><circle cx='103' cy='50' r='2.4' fill='#e8fbf6'/><circle cx='-3' cy='50' r='2.4' fill='#fff3e6'/>`,
      5,
    ),

  breath:
    `<defs><radialGradient id='§h' cx='50' cy='50' r='61' gradientUnits='userSpaceOnUse'><stop offset='.85' stop-color='#5fb3a3' stop-opacity='0'/><stop offset='.91' stop-color='#5fb3a3' stop-opacity='.7'/><stop offset='1' stop-color='#5fb3a3' stop-opacity='0'/></radialGradient></defs>` +
    `<circle cx='50' cy='50' r='61' fill='url(#§h)' ${moving("glow", "animation-duration:3.6s")}/>` +
    ring(51.6, "#3f9886", 2.2) +
    ring(55.4, "#5fb3a3", 0.9, "stroke-dasharray='1 4.4' stroke-linecap='round'") +
    [
      [90, 6, 6, 0],
      [5, 22, 4.5, -1.3],
      [97, 80, 4, -2.4],
    ]
      .map(
        ([x, y, s, delay]) =>
          `<path d='${sparkle(x, y, s)}' fill='#3f9886' ${moving("twinkle", `animation-duration:2.6s;animation-delay:${delay}s`)}/>`,
      )
      .join(""),

  laurel:
    `<defs>${GOLD}${LEAF}<linearGradient id='§r' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#d4473a'/><stop offset='1' stop-color='#94261c'/></linearGradient></defs>` +
    ring(51.2, "url(#§gold)", 1.6) +
    `<path d='${stem(56, 10, 152)}' fill='none' stroke='#b07a12' stroke-width='1.1' stroke-linecap='round'/>` +
    `<g fill='url(#§gold)' stroke='#8a5d0c' stroke-width='.3'>${branches(56, 18, 150, 8, 0.82)}</g>` +
    `<path d='M50 104l-7 -4.5v9z M50 104l7 -4.5v9z' fill='url(#§r)'/><path d='M48.5 105l-4 7.5l2.8 -.6l1.2 2.4z M51.5 105l4 7.5l-2.8 -.6l-1.2 2.4z' fill='#94261c'/><circle cx='50' cy='104' r='2.2' fill='#c0392b' stroke='#f3d77a' stroke-width='.5'/>` +
    glint(51.2, 6, "#fffbe6", 1.4) +
    `<path d='${sparkle(50, -7, 4.5)}' fill='#f3c34a' ${moving("twinkle", "animation-duration:2.4s")}/>`,

  sprout:
    `<defs><linearGradient id='§p' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#b6e07a'/><stop offset='1' stop-color='#4c9a2a'/></linearGradient><linearGradient id='§q' x1='0' y1='1' x2='1' y2='0'><stop offset='0' stop-color='#6fbf3b'/><stop offset='1' stop-color='#c9ef8f'/></linearGradient></defs>` +
    ring(52.5, "url(#§p)", 3) +
    ring(50.2, "#fff", 0.8, "stroke-opacity='.8'") +
    `<g class='look-motion animate-look-swing' style='transform-box:fill-box;transform-origin:50% 100%'><path d='M50 1C50 -3 49.2 -6.5 50 -10' fill='none' stroke='#4c9a2a' stroke-width='1.7' stroke-linecap='round'/><path d='M50 -6C44.5 -5.6 40.4 -9.4 39 -14.2C44.6 -14.4 48.4 -11.2 50 -6Z' fill='url(#§q)'/><path d='M50 -9C55.2 -9.6 59.4 -13.6 61.4 -18.4C55.4 -18.6 51.4 -14.8 50 -9Z' fill='url(#§q)'/><circle cx='58.6' cy='-15' r='.9' fill='#fff' opacity='.8'/></g>`,

  gilt:
    `<defs><linearGradient id='§m' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#7a5410'/><stop offset='.22' stop-color='#f7e08a'/><stop offset='.45' stop-color='#b07a12'/><stop offset='.68' stop-color='#fff2b8'/><stop offset='1' stop-color='#8a5d0c'/></linearGradient><linearGradient id='§e' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f06a7c'/><stop offset='1' stop-color='#8e1b2c'/></linearGradient></defs>` +
    ring(53, "url(#§m)", 5) +
    ring(50.2, "#7a5410", 0.7, "stroke-opacity='.55'") +
    Array.from({ length: 24 }, (_, i) => point(53, i * 15 + 7.5))
      .map((p) => `<circle cx='${p.x}' cy='${p.y}' r='.75' fill='#fff6d0'/>`)
      .join("") +
    glint(53, 4.5, "#fffbe6", 2.2) +
    `<path d='M50 95.5L56.5 103L50 110.5L43.5 103Z' fill='url(#§e)' stroke='#f7e08a' stroke-width='1.1'/><path d='M50 97.5L53 101.5H47Z' fill='#fff' opacity='.7'/>`,

  trophy:
    `<defs>${GOLD}</defs>` +
    ring(52, "url(#§gold)", 2.6) +
    `<g fill='url(#§gold)' stroke='#8a5d0c' stroke-width='.5'><path d='M41.5 88.5H58.5V93C58.5 98.6 54.8 101.6 50 101.6C45.2 101.6 41.5 98.6 41.5 93Z'/><rect x='48.4' y='101.4' width='3.2' height='4.2'/><rect x='44' y='105.4' width='12' height='3.4' rx='1'/></g>` +
    `<path d='M41.6 90.6C36.6 90.4 36.4 97.4 42.4 98.2M58.4 90.6C63.4 90.4 63.6 97.4 57.6 98.2' fill='none' stroke='#c99a2e' stroke-width='1.5' stroke-linecap='round'/>` +
    `<path d='${sparkle(50, 94, 2.6)}' fill='#fff6d0'/>` +
    [
      [35, 99, 3, 0],
      [66, 95, 3.4, -1.1],
      [61, 84, 2.2, -1.9],
    ]
      .map(
        ([x, y, s, delay]) =>
          `<path d='${sparkle(x, y, s)}' fill='#e9b860' ${moving("twinkle", `animation-duration:2.2s;animation-delay:${delay}s`)}/>`,
      )
      .join(""),

  wreath:
    `<defs>${LEAF}</defs>` +
    ring(53.5, "#5f9e4a", 1.4) +
    `<g fill='#79b45c' stroke='#4f8a3a' stroke-width='.3'>${branches(53.5, 10, 170, 10, 0.5)}</g>` +
    [
      [-50, "#f4a7bd"],
      [40, "#fff"],
      [100, "#f6b98a"],
      [150, "#c3b0e6"],
      [215, "#f4a7bd"],
      [265, "#fff"],
    ]
      .map(([a, color], i) => {
        const p = point(53.5, Number(a));
        return flower(p.x, p.y, String(color), -i * 0.5);
      })
      .join(""),

  confetti:
    ["#ef9f70", "#7cc4b8", "#c3b0e6", "#f4a7bd"]
      .map((color, i) =>
        ring(
          52.5,
          color,
          2.6,
          `stroke-dasharray='70 259.87' stroke-dashoffset='${-i * 82.47}' stroke-linecap='round'`,
        ),
      )
      .join("") +
    `<g ${moving("twinkle", "animation-duration:2.4s")}>${confetti(0)}</g>` +
    `<g ${moving("twinkle", "animation-duration:2.4s;animation-delay:-1.2s")}>${confetti(1)}</g>`,

  medal:
    `<defs>${GOLD}<linearGradient id='§v' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#f2f4f7'/><stop offset='.4' stop-color='#9aa5b1'/><stop offset='.7' stop-color='#e1e6eb'/><stop offset='1' stop-color='#6f7a86'/></linearGradient></defs>` +
    ring(52.5, "url(#§v)", 3) +
    glint(52.5, 6, "#fff", 1.6) +
    `<path d='M39.5 87h7l5 15h-6z' fill='#2f6fb0'/><path d='M53.5 87h7l-6 15h-6z' fill='#c0392b'/>` +
    `<circle cx='50' cy='105.5' r='6.6' fill='url(#§gold)' stroke='#8a5d0c' stroke-width='.5'/><circle cx='50' cy='105.5' r='4.8' fill='none' stroke='#b07a12' stroke-width='.6'/><path d='${sparkle(50, 105.5, 3)}' fill='#fff6d0'/>` +
    `<path d='${sparkle(59.5, 99, 2.4)}' fill='#fff' ${moving("twinkle", "animation-duration:2s")}/>`,
};

// Laid over the avatar, a fifth wider. One that doesn't move stays as it starts (design §8.16).
export function AvatarFrame({ frame }: { frame: { key: Frame; moving: boolean } }) {
  const prefix = useId().replaceAll(/\W/g, "");
  return (
    <svg
      // Starting over when it stops moving, as it stands still for others.
      key={String(frame.moving)}
      viewBox="-12 -12 124 124"
      aria-hidden
      className={cn(
        "pointer-events-none absolute -top-[12%] -left-[12%] size-[124%] overflow-visible",
        !frame.moving && "[--play:paused]",
      )}
      dangerouslySetInnerHTML={{ __html: ART[frame.key].replaceAll("§", prefix) }}
    />
  );
}
