import { correction, generate } from "lean-qr";
import sharp from "sharp";

// The payee's codes drawn again from what they hold (design §8.21), in the site's ink with rounded
// finder patterns: a PNG, which people can long-press to save and then pick from their album in
// WeChat or Alipay, as an SVG can't be.

// Pixels per module, and modules of white around the code that scanners need.
const MODULE = 12;
const QUIET = 3;
const INK = "#1f2a28";
const TEAL = "#2b7a6b";

function svg(text: string) {
  const code = generate(text, { minCorrectionLevel: correction.M });
  const n = code.size;
  const corners = [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ];
  const inCorner = (x: number, y: number) =>
    corners.some(([cx, cy]) => x >= cx && x < cx + 7 && y >= cy && y < cy + 7);
  const modules = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (code.get(x, y) && !inCorner(x, y)) modules.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  const finders = corners.map(
    ([x, y]) =>
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="1.6" fill="none" stroke="${TEAL}"/>` +
      `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.8" fill="${TEAL}"/>`,
  );
  const side = n + QUIET * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-QUIET} ${-QUIET} ${side} ${side}" width="${side * MODULE}" height="${side * MODULE}">
    <rect x="${-QUIET}" y="${-QUIET}" width="${side}" height="${side}" fill="#fff"/>
    <path d="${modules.join("")}" fill="${INK}" shape-rendering="crispEdges"/>${finders.join("")}
  </svg>`;
}

// By what the code holds; one replaced in the settings leaves its old picture behind, and codes
// are hardly ever replaced.
const drawn = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

export function codeImage(text: string) {
  let png = drawn.get(text);
  if (!png) {
    // Copied out of sharp's Buffer, which may sit on memory shared between threads, to bytes a
    // response can carry.
    png = sharp(Buffer.from(svg(text)))
      .png({ palette: true })
      .toBuffer()
      .then((buffer) => new Uint8Array(buffer));
    drawn.set(text, png);
  }
  return png;
}
