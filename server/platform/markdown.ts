import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import { FilterXSS } from "xss";
import { env } from "./env.ts";

// Markdown is rendered once, when a post is written or edited, and stored next to its source.
// Raw HTML is off, and the result goes through an allowlist anyway.

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
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

const sanitizer = new FilterXSS({
  whiteList: {
    a: ["href", "title", "class", "rel"],
    blockquote: [],
    br: [],
    code: ["class"],
    em: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    h6: [],
    hr: [],
    img: ["src", "alt", "title", "loading"],
    input: ["type", "checked", "disabled"],
    li: ["class"],
    ol: ["start"],
    p: [],
    pre: [],
    s: [],
    span: ["class"],
    strong: [],
    table: [],
    tbody: [],
    td: ["style"],
    th: ["style"],
    thead: [],
    tr: [],
    ul: [],
  },
  // Table alignment.
  css: { whiteList: { "text-align": true } },
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

// Marks up a paragraph's inline tokens: mentions, external links, images, task boxes.
function inline(children: InstanceType<typeof Token>[], mentions: Set<number>) {
  const out: InstanceType<typeof Token>[] = [];
  for (const [i, token] of children.entries()) {
    if (token.type === "link_open") {
      const href = attr(token, "href");
      const mention = MENTION.exec(href);
      if (mention && children.at(i + 1)?.content.startsWith("@")) {
        token.attrJoin("class", "mention");
        mentions.add(Number(mention[1]));
      }
      if (isExternal(href)) token.attrSet("rel", "ugc nofollow noopener");
    }
    // Only uploaded images are shown; others become links, so pages don't load strangers' files.
    const src = attr(token, "src");
    if (token.type === "image" && !src.startsWith("/uploads/")) {
      const [open, ...rest] = link(src, token.content || src);
      if (isExternal(src)) open.attrSet("rel", "ugc nofollow noopener");
      out.push(open, ...rest);
      continue;
    }
    if (token.type === "image") token.attrSet("loading", "lazy");
    out.push(token);
  }
  return out;
}

export async function renderMarkdown(source: string) {
  const tokens = md.parse(source, {});
  if (tokens.some((t) => t.type === "fence")) await loadLanguages();
  const mentions = new Set<number>();

  for (const [i, token] of tokens.entries()) {
    if (token.type === "inline" && token.children) {
      token.children = inline(token.children, mentions);
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
    if (token.type === "fence") {
      const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
      if (hljs.getLanguage(lang)) {
        const code = hljs.highlight(token.content, { language: lang, ignoreIllegals: true });
        token.type = "html_block";
        token.content = `<pre><code class="hljs">${code.value}</code></pre>\n`;
      }
    }
  }

  const html = sanitizer.process(md.renderer.render(tokens, md.options, {}));
  return { html, mentions: [...mentions] };
}
