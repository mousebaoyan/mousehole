import { useEffect, useRef, useState, type RefObject } from "react";
import { useFetcher } from "react-router";
import { AtSign, Bold, Code, Eye, ImagePlus, Link2, PenLine, Quote } from "~/components/icons";
import type { loader as mentionLoader } from "~/routes/mention";
import { cn } from "cn";
import type { UserBrief } from "~/api-types";
import { browserApi } from "~/browser-api";
import { EmojiButton } from "~/components/emoji-button";
import { PROSE } from "~/components/prose";
import { Button } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";

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

const MAX_IMAGE = 20 * 1024 * 1024;

function imageFiles(list: FileList) {
  return [...list].filter((f) => f.type.startsWith("image/"));
}

const TOOLS = [
  { label: "粗体", icon: Bold, edit: wrap("**", "**", "粗体") },
  { label: "引用", icon: Quote, edit: prefixLines("> ") },
  { label: "代码", icon: Code, edit: code },
  { label: "链接", icon: Link2, edit: link },
  { label: "提及", icon: AtSign, edit: wrap("@", "", "") },
];

// "@" being typed and the text after it, up to the caret. Not after a letter or digit, so an
// email address isn't a mention.
const MENTION = /(?:^|[^\w])@([^\s@[\]()]{0,20})$/;

// `y` is where the caret's line is in the editor column, for placing the suggestions next to it:
// below the line in the upper half of the text box, above it in the lower half.
type Mention = { start: number; query: string; y: number; above: boolean };

const MIRRORED = [
  "box-sizing",
  "width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "tab-size",
];

function findMention(el: HTMLTextAreaElement, text: string, caret: number): Mention | null {
  const match = MENTION.exec(text.slice(0, caret));
  if (!match) return null;
  // The caret's position, from a hidden copy of the text box laid out the same way.
  const mirror = document.createElement("div");
  const style = getComputedStyle(el);
  for (const name of MIRRORED) mirror.style.setProperty(name, style.getPropertyValue(name));
  mirror.style.cssText +=
    "position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word";
  mirror.textContent = text.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const lineTop = marker.offsetTop - el.scrollTop;
  const lineBottom = lineTop + marker.offsetHeight;
  mirror.remove();
  const above = lineTop > el.clientHeight / 2;
  return {
    start: caret - match[1].length - 1,
    query: match[1],
    y: el.offsetTop + (above ? lineTop : lineBottom),
    above,
  };
}

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
  const [mention, setMention] = useState<Mention | null>(null);
  const [chosen, setChosen] = useState(0);
  const people = useFetcher<typeof mentionLoader>();
  const suggestions = mention?.query ? (people.data ?? []) : [];
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  // Suggestions for the name after "@", once typing pauses.
  const query = mention?.query;
  const { load } = people;
  useEffect(() => {
    if (!query) return undefined;
    const timer = setTimeout(() => void load(`/mention?q=${encodeURIComponent(query)}`), 150);
    return () => clearTimeout(timer);
  }, [query, load]);

  function change(text: string, caret: number) {
    onChange(text);
    const el = textarea.current;
    setMention(el && findMention(el, text, caret));
    setChosen(0);
  }

  function apply(edit: Edit) {
    const el = textarea.current;
    if (!el) return;
    const result = edit(el.value, el.selectionStart, el.selectionEnd);
    change(result.text, result.select[1]);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(...result.select);
    });
  }

  // Each image gets a placeholder at the caret, replaced by the image once it is uploaded. The
  // text box holds the latest text, which may have changed while the image was on its way.
  async function upload(files: File[]) {
    setUploadError(null);
    for (const file of files) {
      const el = textarea.current;
      if (!el) return;
      if (file.size > MAX_IMAGE) {
        setUploadError(`${file.name} 超过 20MB`);
        continue;
      }
      const caret = el.selectionEnd;
      // On a line of its own.
      const placeholder = `${caret === 0 || el.value[caret - 1] === "\n" ? "" : "\n"}![上传中：${file.name}…]()`;
      change(
        el.value.slice(0, caret) + placeholder + el.value.slice(caret),
        caret + placeholder.length,
      );
      const res = await browserApi.uploads.$post({ form: { file } });
      const alt = file.name.replace(/\.[^.]*$/, "").replaceAll(/[[\]]/g, "");
      if (res.ok) {
        onChange(el.value.replace(placeholder, `![${alt}](${(await res.json()).url})`));
      } else {
        onChange(el.value.replace(placeholder, ""));
        setUploadError(`${file.name}：${(await res.json()).error.message}`);
      }
    }
  }

  // Brackets in a name would end the link text early.
  function pick(user: UserBrief) {
    const el = textarea.current;
    if (!el || !mention) return;
    const name = user.display_name.replaceAll(/[[\]]/g, "\\$&");
    const inserted = `[@${name}](/u/${user.id}) `;
    const caret = mention.start + inserted.length;
    onChange(value.slice(0, mention.start) + inserted + value.slice(el.selectionStart));
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className={cn("grid min-h-0 md:grid-cols-2", className)}>
      <div
        className={cn("relative flex min-h-0 flex-col md:border-r", previewing && "max-md:hidden")}
      >
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
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="图片"
            title="图片"
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus />
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void upload(imageFiles(e.target.files));
              e.target.value = "";
            }}
          />
          <EmojiButton target={textarea} onChange={onChange} />
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
          onChange={(e) => change(e.target.value, e.target.selectionStart)}
          onClick={(e) =>
            setMention(findMention(e.currentTarget, value, e.currentTarget.selectionStart))
          }
          onBlur={() => setMention(null)}
          onPaste={(e) => {
            const pasted = imageFiles(e.clipboardData.files);
            if (pasted.length === 0) return;
            e.preventDefault();
            void upload(pasted);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const dropped = imageFiles(e.dataTransfer.files);
            if (dropped.length === 0) return;
            e.preventDefault();
            void upload(dropped);
          }}
          onKeyDown={(e) => {
            if (suggestions.length > 0) {
              const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
              if (move !== undefined) {
                e.preventDefault();
                setChosen((chosen + move + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(suggestions[chosen]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
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
          placeholder="支持 Markdown；输入 @ 加名字或 QQ 号提及成员；可粘贴或拖入图片"
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-body leading-7 outline-none placeholder:text-muted-foreground"
        />
        {uploadError !== null && (
          <p role="alert" className="border-t px-4 py-1.5 text-meta text-destructive">
            {uploadError}
          </p>
        )}
        {suggestions.length > 0 && (
          <ul
            aria-label="提及"
            className={cn(
              "absolute inset-x-2 z-10 max-h-48 space-y-0.5 overflow-y-auto rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-lg",
              mention?.above && "-translate-y-full",
            )}
            style={{ top: mention?.y }}
          >
            {suggestions.map((user, i) => (
              <li key={user.id}>
                <button
                  type="button"
                  // Keeps the focus in the textarea, which closes the list when it is lost.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(user)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left",
                    i === chosen ? "bg-accent" : "hover:bg-accent",
                  )}
                >
                  <UserAvatar user={user} className="size-6 text-2xs" />
                  <span className="truncate">{user.display_name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {user.qq}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
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
