import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useDismiss } from "~/components/disclosure";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useTags } from "~/forum";

const MAX_TAGS = 5;

const TAG_GROUPS = [
  { kind: "topic", label: "话题" },
  { kind: "school", label: "院校" },
  { kind: "major", label: "方向" },
];

// The chosen tags, and a list to add more from; schools are many, so the list can be filtered.
export function TagPicker({
  chosen,
  onChange,
}: {
  chosen: string[];
  onChange: (tags: string[]) => void;
}) {
  const tags = useTags();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useDismiss(open, () => setOpen(false), root);
  const matching = tags.filter((t) => !chosen.includes(t.name) && t.name.includes(filter.trim()));

  return (
    <div ref={root} className="relative flex flex-wrap items-center gap-1.5">
      {chosen.map((name) => (
        <span
          key={name}
          className="inline-flex items-center gap-0.5 rounded-full bg-secondary py-0.5 pr-1 pl-2.5 text-sm"
        >
          #{name}
          <button
            type="button"
            aria-label={`去掉 ${name}`}
            onClick={() => onChange(chosen.filter((t) => t !== name))}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
      {chosen.length < MAX_TAGS && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            requestAnimationFrame(() => input.current?.focus());
          }}
          className="text-muted-foreground"
        >
          <Plus /> 标签
        </Button>
      )}
      {open && (
        <div className="absolute top-full left-0 z-50 mt-2 flex max-h-80 w-64 flex-col rounded-xl border bg-popover text-sm text-popover-foreground shadow-lg">
          <div className="border-b p-1.5">
            <Input
              ref={input}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="筛选标签"
              placeholder="筛选"
            />
          </div>
          <div className="overflow-y-auto p-1">
            {TAG_GROUPS.map((g) => {
              const group = matching.filter((t) => t.kind === g.kind);
              return (
                group.length > 0 && (
                  <div key={g.kind}>
                    <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">{g.label}</div>
                    {group.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          onChange([...chosen, t.name]);
                          setFilter("");
                          if (chosen.length + 1 >= MAX_TAGS) setOpen(false);
                        }}
                        className="flex w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-accent"
                      >
                        #{t.name}
                      </button>
                    ))}
                  </div>
                )
              );
            })}
            {matching.length === 0 && (
              <p className="px-2.5 py-2 text-muted-foreground">没有匹配的标签</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
