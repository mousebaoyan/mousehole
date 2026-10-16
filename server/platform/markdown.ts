import { randomBytes } from "node:crypto";
import MarkdownIt, { type StateBlock, type StateCore, type StateInline } from "markdown-it";
import footnote from "markdown-it-footnote";
import mark from "markdown-it-mark";
import hljs from "highlight.js/lib/core";
import temml from "temml";
import { FilterXSS } from "xss";
import { env } from "./env.ts";

// Markdown is rendered once, when a post is written or edited, and stored next to its source.
// Raw HTML is off, and the result goes through an allowlist anyway. Design §8.2 lists what the
// syntax adds to GFM.

// Raised whenever the HTML written for the same Markdown changes; start-up then renders the floors
// written before again.
export const RENDER_VERSION = 1;

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(mark).use(footnote);
const { Token } = new md.core.State("", md, {});

const SITE = new URL(env.PUBLIC_URL).origin;

// `[@鼠鼠](/u/7)` is how the editor writes a mention; the name is whatever it was then.
const MENTION = /^\/u\/(\d+)$/;

const TASK = /^\[([ xX])\] /;

// Languages people post here, registered on the first code block; others stay plain text.
// highlight.js rather than Shiki: Shiki's grammars took over 100MB for C++ alone, more than this
// whole process may use. Classes instead of inline colors also keep the HTML small.
let languages: Promise<void> | undefined;

function loadLanguages() {
  languages ??= Promise.all(
    Object.entries({
      bash: import("highlight.js/lib/languages/bash"),
      c: import("highlight.js/lib/languages/c"),
      cpp: import("highlight.js/lib/languages/cpp"),
      csharp: import("highlight.js/lib/languages/csharp"),
      css: import("highlight.js/lib/languages/css"),
      diff: import("highlight.js/lib/languages/diff"),
      go: import("highlight.js/lib/languages/go"),
      java: import("highlight.js/lib/languages/java"),
      javascript: import("highlight.js/lib/languages/javascript"),
      json: import("highlight.js/lib/languages/json"),
      kotlin: import("highlight.js/lib/languages/kotlin"),
      latex: import("highlight.js/lib/languages/latex"),
      matlab: import("highlight.js/lib/languages/matlab"),
      python: import("highlight.js/lib/languages/python"),
      rust: import("highlight.js/lib/languages/rust"),
      sql: import("highlight.js/lib/languages/sql"),
      typescript: import("highlight.js/lib/languages/typescript"),
      verilog: import("highlight.js/lib/languages/verilog"),
      xml: import("highlight.js/lib/languages/xml"),
      yaml: import("highlight.js/lib/languages/yaml"),
    }).map(async ([name, module]) => hljs.registerLanguage(name, (await module).default)),
  ).then(() => undefined);
  return languages;
}

// ---- Callouts: GitHub's alerts, "> [!TIP]" opening a quote, with Obsidian's additions: a title
// after the type, and "-" or "+" right after it to fold the box, shut or open. A fold is a
// <details>, which opens without the page's script.

const CALLOUTS: Record<string, string> = {
  note: "说明",
  tip: "提示",
  important: "重要",
  warning: "注意",
  caution: "警告",
  fold: "详情",
};
const CALLOUT = /^\[!(note|tip|important|warning|caution|fold)\]([+-]?)[ \t]*(.*)$/i;

function callouts(state: StateCore) {
  const { tokens } = state;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== "blockquote_open" || tokens[i + 1].type !== "paragraph_open") continue;
    const paragraph = tokens[i + 2];
    const [first, ...rest] = paragraph.content.split("\n");
    const found = CALLOUT.exec(first);
    if (!found) continue;
    const kind = found[1].toLowerCase();
    const fold = found[2] !== "" || kind === "fold";
    const close = tokens.findIndex(
      (t, j) => j > i && t.type === "blockquote_close" && t.level === open.level,
    );
    open.tag = tokens[close].tag = fold ? "details" : "div";
    open.attrSet("class", `callout callout-${kind}`);
    if (found[2] === "+") open.attrSet("open", "");

    const titleOpen = new state.Token("callout_title_open", fold ? "summary" : "p", 1);
    if (!fold) titleOpen.attrSet("class", "callout-title");
    const title = new state.Token("inline", "", 0);
    title.content = found[3].trim() || CALLOUTS[kind];
    title.children = [];
    const titleClose = new state.Token("callout_title_close", titleOpen.tag, -1);
    titleOpen.block = titleClose.block = true;
    // The marker's line goes; a paragraph that was only the marker goes with it.
    paragraph.content = rest.join("\n");
    tokens.splice(i + 1, rest.length > 0 ? 0 : 3, titleOpen, title, titleClose);
  }
}

md.core.ruler.after("block", "callout", callouts);

// ---- Spoilers, "||hidden||" as in Discord. The built-in text rule runs on past "|", so this one
// stands in for it, stopping there as well.

const TEXT_END = /[\n!#$%&*+\-:<=>@[\\\]^_`{}~|]/g;

function plainRun(state: StateInline, silent: boolean) {
  TEXT_END.lastIndex = state.pos;
  const end = Math.min(TEXT_END.exec(state.src)?.index ?? state.posMax, state.posMax);
  if (end === state.pos) return false;
  if (!silent) state.pending += state.src.slice(state.pos, end);
  state.pos = end;
  return true;
}

function spoiler(state: StateInline, silent: boolean) {
  const start = state.pos;
  if (!state.src.startsWith("||", start)) return false;
  const end = state.src.indexOf("||", start + 2);
  if (end === -1 || end === start + 2 || end + 2 > state.posMax) return false;
  if (!silent) {
    // Focusable, so a tap shows it before the page's script runs.
    state.push("spoiler_open", "span", 1).attrs = [
      ["class", "spoiler"],
      ["tabindex", "0"],
    ];
    const max = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = max;
    state.push("spoiler_close", "span", -1);
  }
  state.pos = end + 2;
  return true;
}

md.inline.ruler.at("text", plainRun);
md.inline.ruler.after("text", "spoiler", spoiler);

// ---- Formulas: $…$ in a line, $$…$$ on lines of their own. Temml writes MathML, which browsers
// lay out themselves, so pages load no script for it. As in Pandoc, a dollar opens only
// before a non-space and closes only after one and not before a digit, so prices stay text.

const INLINE_MATH = /^\$(?=\S)((?:\\.|[^\\$])+?)(?<=\S)\$(?!\d)/;

function inlineMath(state: StateInline, silent: boolean) {
  if (state.src[state.pos] !== "$") return false;
  const found = INLINE_MATH.exec(state.src.slice(state.pos, state.posMax));
  if (!found) return false;
  if (!silent) state.push("math_inline", "math", 0).content = found[1];
  state.pos += found[0].length;
  return true;
}

function blockMath(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4 || !state.src.startsWith("$$", start)) {
    return false;
  }
  let line = startLine;
  let last = state.src.slice(start + 2, state.eMarks[line]);
  const lines = [last];
  while (!last.trimEnd().endsWith("$$")) {
    line++;
    if (line >= endLine || state.sCount[line] < state.blkIndent) return false;
    last = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    lines.push(last);
  }
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.content = lines.join("\n").trimEnd().slice(0, -2);
  token.map = [startLine, line + 1];
  token.block = true;
  state.line = line + 1;
  return true;
}

// A formula that doesn't parse shows as written, for its author to see in the preview.
function formula(tex: string, displayMode: boolean) {
  try {
    return temml.renderToString(tex, { displayMode, annotate: true, throwOnError: true });
  } catch (error) {
    if (!(error instanceof temml.ParseError)) throw error;
    const marks = displayMode ? "$$" : "$";
    return md.utils.escapeHtml(marks + tex + marks);
  }
}

md.inline.ruler.after("escape", "math_inline", inlineMath);
md.block.ruler.before("fence", "math_block", blockMath, {
  alt: ["paragraph", "reference", "blockquote", "list"],
});
md.renderer.rules.math_inline = (tokens, i) => formula(tokens[i].content, false);
// In a box of its own, which scrolls when the formula is wider than a phone.
md.renderer.rules.math_block = (tokens, i) =>
  `<div class="math">${formula(tokens[i].content, true)}</div>\n`;

// ---- Footnotes: the plugin's, without the rule it draws above them. Their ids carry `docId`,
// as a page shows many posts.
md.renderer.rules.footnote_block_open = () => '<section class="footnotes">\n<ol>\n';

// What Temml writes and needs kept.
const MATH_TAGS = [
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "mspace",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mover",
  "munder",
  "munderover",
  "mmultiscripts",
  "mprescripts",
  "none",
  "mtable",
  "mtr",
  "mtd",
  "mlabeledtr",
  "mpadded",
  "mphantom",
  "menclose",
  "mstyle",
];
const MATH_ATTRS = [
  "class",
  "style",
  "display",
  "displaystyle",
  "scriptlevel",
  "encoding",
  "mathvariant",
  "stretchy",
  "fence",
  "form",
  "separator",
  "lspace",
  "rspace",
  "minsize",
  "maxsize",
  "movablelimits",
  "largeop",
  "symmetric",
  "accent",
  "accentunder",
  "linethickness",
  "notation",
  "width",
  "height",
  "depth",
  "voffset",
  "columnalign",
  "rowalign",
  "columnspacing",
  "rowspacing",
  "columnlines",
  "rowlines",
  "rowspan",
  "columnspan",
];

const sanitizer = new FilterXSS({
  whiteList: {
    ...Object.fromEntries(MATH_TAGS.map((tag) => [tag, MATH_ATTRS])),
    a: ["href", "title", "class", "rel", "id"],
    blockquote: [],
    br: [],
    button: ["type", "class", "aria-label", "data-lines"],
    code: ["class"],
    details: ["class", "open"],
    div: ["class", "data-lang"],
    em: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    h6: [],
    hr: [],
    img: ["src", "alt", "title", "width", "height", "loading"],
    input: ["type", "checked", "disabled"],
    li: ["class", "id"],
    mark: [],
    ol: ["start"],
    p: ["class"],
    pre: [],
    s: [],
    section: ["class"],
    span: ["class", "tabindex"],
    strong: [],
    summary: [],
    sup: ["class"],
    table: [],
    tbody: [],
    td: ["style"],
    th: ["style"],
    thead: [],
    tr: [],
    ul: [],
  },
  // Table alignment, and the spacing Temml gives matrix cells.
  css: { whiteList: { "text-align": true, "padding-left": true, "padding-right": true } },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
});

function isExternal(href: string) {
  return URL.parse(href, SITE)?.origin !== SITE;
}

function attr(token: InstanceType<typeof Token>, name: string) {
  return String(token.attrGet(name) ?? "");
}

function link(href: string, text: string) {
  const open = new Token("link_open", "a", 1);
  open.attrSet("href", href);
  const body = new Token("text", "", 0);
  body.content = text;
  return [open, body, new Token("link_close", "a", -1)];
}

// An image a post may show: the file to load, the larger one it opens, and its size on the page.
export type ShownImage = { src: string; href: string; width: number; height: number };

// Marks up a paragraph's inline tokens: mentions, external links, images. Mentions and external
// links are collected on the way.
function inline(
  children: InstanceType<typeof Token>[],
  found: { mentions: Set<number>; links: Set<string> },
  images: Map<string, ShownImage>,
) {
  const out: InstanceType<typeof Token>[] = [];
  for (const [i, token] of children.entries()) {
    if (token.type === "link_open") {
      const href = attr(token, "href");
      const mention = MENTION.exec(href);
      if (mention && children.at(i + 1)?.content.startsWith("@")) {
        token.attrJoin("class", "mention");
        found.mentions.add(Number(mention[1]));
      }
      if (isExternal(href)) {
        token.attrSet("rel", "ugc nofollow noopener");
        found.links.add(href);
      }
    }
    if (token.type !== "image") {
      out.push(token);
      continue;
    }
    // Only images uploaded here are shown, with their size written down so the page doesn't
    // jump as they load; others become links, so pages don't load strangers' files.
    const src = attr(token, "src");
    const image = images.get(src);
    if (image) {
      const shown = new Token("html_inline", "", 0);
      const escape = md.utils.escapeHtml;
      shown.content = `<a href="${escape(image.href)}"><img src="${escape(image.src)}" alt="${escape(token.content)}" width="${image.width}" height="${image.height}" loading="lazy"></a>`;
      out.push(shown);
    } else {
      const [open, ...rest] = link(src, token.content || src);
      if (isExternal(src)) {
        open.attrSet("rel", "ugc nofollow noopener");
        found.links.add(src);
      }
      out.push(open, ...rest);
    }
  }
  return out;
}

// Longer code is cut to 20 lines, with a button to show the rest.
const LONG_CODE = 24;

// A code block with its language and a copy button above it, which components/post-body.tsx
// works. Their labels are drawn by app.css, so excerpts and search don't take them for text.
function codeBlock(source: string, lang: string) {
  const escape = md.utils.escapeHtml;
  const language = hljs.getLanguage(lang);
  const code = language
    ? `<code class="hljs">${hljs.highlight(source, { language: lang, ignoreIllegals: true }).value}</code>`
    : `<code>${escape(source)}</code>`;
  const name = language?.name ?? lang;
  const lines = source.split("\n").length - 1;
  const long = lines > LONG_CODE;
  return (
    `<div class="code${long ? " long" : ""}"${name ? ` data-lang="${escape(name)}"` : ""}>` +
    `<pre>${code}</pre><button type="button" class="code-copy" aria-label="复制代码"></button>` +
    `${long ? `<button type="button" class="code-more" data-lines="${lines}"></button>` : ""}</div>\n`
  );
}

// `images` says which of the image addresses in the text may be shown, and how. The result lists
// those that are, so the caller can keep track of what the post uses, and the links to other
// sites, which new members may only have a few of.
export async function renderMarkdown(
  source: string,
  images: (srcs: string[]) => Promise<Map<string, ShownImage>>,
) {
  const doc = { docId: randomBytes(3).toString("hex") };
  const tokens = md.parse(source, doc);
  if (tokens.some((t) => t.type === "fence")) await loadLanguages();
  const found = { mentions: new Set<number>(), links: new Set<string>() };
  const srcs = tokens
    .flatMap((t) => t.children ?? [])
    .filter((t) => t.type === "image")
    .map((t) => attr(t, "src"));
  const shown = srcs.length > 0 ? await images([...new Set(srcs)]) : new Map<string, ShownImage>();

  for (const [i, token] of tokens.entries()) {
    if (token.type === "inline" && token.children) {
      token.children = inline(token.children, found, shown);
      // `- [x] done` in a list.
      const first = token.children.at(0);
      const task = first?.type === "text" ? TASK.exec(first.content) : null;
      if (first && task && i >= 2 && tokens[i - 2].type === "list_item_open") {
        first.content = first.content.slice(task[0].length);
        const box = new Token("html_inline", "", 0);
        box.content = `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> `;
        token.children.unshift(box);
        tokens[i - 2].attrJoin("class", "task");
      }
    }
    if (token.type === "fence" || token.type === "code_block") {
      token.content = codeBlock(token.content, token.info.trim().split(/\s+/)[0].toLowerCase());
      token.type = "html_block";
    }
  }

  const html = sanitizer.process(md.renderer.render(tokens, md.options, doc));
  return {
    html,
    mentions: [...found.mentions],
    images: [...shown.keys()],
    links: [...found.links],
  };
}

// The ones the renderer writes.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" };

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

const SPOILER = /<span class="spoiler"[^>]*>.*?<\/span>/gs;
// A formula's TeX, which Temml writes alongside its MathML.
const FORMULA = /<math\b.*?<annotation[^>]*>(.*?)<\/annotation>.*?<\/math>/gs;
const FOOTNOTE_LINK =
  /<sup class="footnote-ref">.*?<\/sup>|<a [^>]*class="footnote-backref">.*?<\/a>/g;

// Rendered HTML as plain text: tags dropped, the renderer's escapes undone, spaces collapsed.
// Spoilers stay hidden, in excerpts and mail as on the page.
export function plainText(html: string) {
  return (
    html
      .replaceAll(SPOILER, "▇▇")
      .replaceAll(FORMULA, " $1 ")
      .replaceAll(FOOTNOTE_LINK, "")
      // Blocks are kept apart by a space; inline tags just go.
      .replaceAll(
        /<\/?(?:p|li|h[1-6]|blockquote|pre|br|hr|td|th|div|details|summary|section)\b[^>]*>/g,
        " ",
      )
      .replaceAll(/<[^>]*>/g, "")
      .replaceAll(
        /&(amp|lt|gt|quot|#39|#x27);/g,
        (_, name: keyof typeof ENTITIES) => ENTITIES[name],
      )
      .replaceAll(/\s+/g, " ")
      .trim()
  );
}

// The plain text cut to `max` characters as people see them, for previews.
export function excerpt(html: string, max: number) {
  const text = plainText(html);
  let count = 0;
  for (const { index } of graphemes.segment(text)) {
    if (count === max) return `${text.slice(0, index)}…`;
    count++;
  }
  return text;
}
