import { Bold, Code, Eye, Link2, PenLine, Quote } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { useFetcher } from "react-router";
import { cn } from "cn";
import { EmojiButton } from "~/components/emoji-button";
import { PROSE } from "~/components/prose";
import { Button } from "~/components/ui/button";

// A change to the text and what to select afterwards.
type Edit = (
  text: string,
  start: number,
  end: number,
) => { text: string; select: [number, number] };

function wrap(before: string, after: string, placeholder: string): Edit {
  return (text, start, end) => {
    const inner = text.slice(start, end) || placeholder;
    const from = start + before.length;
    return {
      text: text.slice(0, start) + before + inner + after + text.slice(end),
      select: [from, from + inner.length],
    };
  };
}

// Puts `prefix` before every selected line, as "> " does for a quote.
function prefixLines(prefix: string): Edit {
  return (text, start, end) => {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const block = text
      .slice(lineStart, end)
      .split("\n")
      .map((line) => prefix + line)
      .join("\n");
    return {
      text: text.slice(0, lineStart) + block + text.slice(end),
      select: [lineStart, lineStart + block.length],
    };
  };
}

// A code block around several lines, inline code around a few words.
const code: Edit = (text, start, end) =>
  text.slice(start, end).includes("\n")
    ? wrap("```\n", "\n```", "")(text, start, end)
    : wrap("`", "`", "代码")(text, start, end);

// The address is selected, ready to be typed or pasted over.
const link: Edit = (text, start, end) => {
  const label = text.slice(start, end) || "链接文字";
  const from = start + label.length + 3;
  return {
    text: `${text.slice(0, start)}[${label}](https://)${text.slice(end)}`,
    select: [from, from + "https://".length],
  };
};

const TOOLS = [
  { label: "粗体", icon: Bold, edit: wrap("**", "**", "粗体") },
  { label: "引用", icon: Quote, edit: prefixLines("> ") },
  { label: "代码", icon: Code, edit: code },
  { label: "链接", icon: Link2, edit: link },
];

// Markdown on the left and the server's rendering of it on the right; phones switch between the
// two. Ctrl or ⌘ + Enter submits.
export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  label,
  textarea,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  label: string;
  textarea: RefObject<HTMLTextAreaElement | null>;
  className?: string;
}) {
  const [previewing, setPreviewing] = useState(false);
  const { submit, data } = useFetcher<{ html: string | null }>();

  // Rendered once typing pauses. Nothing here changes data, so nothing else reloads.
  useEffect(() => {
    if (!value.trim()) return undefined;
    const timer = setTimeout(() => {
      void submit(
        { markdown: value },
        { method: "post", action: "/preview", defaultShouldRevalidate: false },
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [value, submit]);

  function apply(edit: Edit) {
    const el = textarea.current;
    if (!el) return;
    const result = edit(el.value, el.selectionStart, el.selectionEnd);
    onChange(result.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(...result.select);
    });
  }

  return (
    <div className={cn("grid min-h-0 md:grid-cols-2", className)}>
      <div className={cn("flex min-h-0 flex-col md:border-r", previewing && "max-md:hidden")}>
        <div className="flex items-center gap-0.5 border-b px-2 py-1 text-muted-foreground">
          {TOOLS.map((t) => (
            <Button
              key={t.label}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.label}
              title={t.label}
              onClick={() => apply(t.edit)}
            >
              <t.icon />
            </Button>
          ))}
          <EmojiButton target={textarea} onChange={onChange} side="top" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto md:hidden"
            aria-label="预览"
            title="预览"
            onClick={() => setPreviewing(true)}
          >
            <Eye />
          </Button>
        </div>
        <textarea
          ref={textarea}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit();
            }
            if (e.key === "b" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              apply(TOOLS[0].edit);
            }
          }}
          aria-label={label}
          placeholder="支持 Markdown"
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-body leading-7 outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className={cn("flex min-h-0 flex-col", !previewing && "max-md:hidden")}>
        <div className="flex h-9 items-center border-b px-2 text-muted-foreground md:hidden">
          <Button type="button" variant="ghost" size="sm" onClick={() => setPreviewing(false)}>
            <PenLine /> 继续编辑
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-secondary/40 px-4 py-1">
          {value.trim() && data?.html ? (
            <div className={PROSE} dangerouslySetInnerHTML={{ __html: data.html }} />
          ) : (
            <p className="py-2 text-body text-muted-foreground">预览</p>
          )}
        </div>
      </div>
    </div>
  );
}
