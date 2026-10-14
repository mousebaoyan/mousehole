// Search terms without a Chinese tokenizer: runs of Han characters become overlapping pairs
// ("保研夏令营" → 保研 研夏 夏令 令营), other text splits into lowercase words of letters and
// digits. Documents and queries go through the same steps; see design §8.5.

const PIECES = /\p{Script=Han}+|[\p{L}\p{N}]+/gu;
const HAN = /^\p{Script=Han}/u;

function bigrams(run: string) {
  const chars = Array.from(run.matchAll(/./gu), ([c]) => c);
  if (chars.length === 1) return chars;
  return chars.slice(1).map((c, i) => chars[i] + c);
}

// Each term of the text, as the tokens it is indexed under.
export function terms(text: string) {
  return [...text.toLowerCase().matchAll(PIECES)].map(([piece]) =>
    HAN.test(piece) ? bigrams(piece) : [piece],
  );
}

// For to_tsvector('simple', …).
export function documentTokens(text: string) {
  return terms(text).flat().join(" ");
}

// For to_tsquery('simple', …): each term a phrase of its tokens, all terms required. Tokens are
// letters and digits only, so they need no quoting beyond this.
export function phraseQuery(text: string, titleOnly = false) {
  // Titles are indexed with weight A.
  const weight = titleOnly ? ":A" : "";
  return terms(text)
    .map((tokens) => tokens.map((t) => `'${t}'${weight}`).join(" <-> "))
    .join(" & ");
}

// Any token at all, for finding what a question is like rather than what contains it.
export function anyQuery(text: string) {
  return [...new Set(terms(text).flat())].map((t) => `'${t}'`).join(" | ");
}

// About `width` characters around where the first of the words appears, for a result's snippet;
// the start of the text when none does.
export function snippet(text: string, words: string[], width = 120) {
  const lower = text.toLowerCase();
  const found = words
    .map((w) => lower.indexOf(w.toLowerCase()))
    .filter((i) => i >= 0)
    .toSorted((a, b) => a - b)
    .at(0);
  const start = Math.max(0, (found ?? 0) - width / 3);
  const end = start + width;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
