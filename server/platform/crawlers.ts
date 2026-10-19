// Crawlers that train AI models or scrape heavily, which robots.txt turns away (design §11.2).
export const UNWELCOME_CRAWLERS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "PerplexityBot",
  "Amazonbot",
  "meta-externalagent",
  "FacebookBot",
  "cohere-ai",
  "Diffbot",
  "Omgilibot",
  "ImagesiftBot",
  "Timpibot",
  "AhrefsBot",
  "SemrushBot",
  "MJ12bot",
  "DotBot",
  "PetalBot",
];

// Programs rather than people: crawlers, link previews, scripts and headless browsers. The names
// above are plain words, safe in a pattern as they are.
const CRAWLER = new RegExp(
  [
    "bot",
    "spider",
    "crawl",
    "slurp",
    "fetch",
    "scrap",
    "curl",
    "wget",
    "python",
    "go-http",
    "java/",
    "okhttp",
    "axios",
    "headless",
    "lighthouse",
    ...UNWELCOME_CRAWLERS,
  ].join("|"),
  "i",
);

export function isCrawler(userAgent: string) {
  return CRAWLER.test(userAgent);
}
