// The markdown-it project's own plugins ship without types.
declare module "markdown-it-footnote" {
  import type { MarkdownIt } from "markdown-it";
  export default function footnote(md: MarkdownIt): void;
}

declare module "markdown-it-mark" {
  import type { MarkdownIt } from "markdown-it";
  export default function mark(md: MarkdownIt): void;
}
