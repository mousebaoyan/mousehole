import { Check, ChevronDown } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { cn } from "cn";
import { matching, menuItem, SEARCH_FROM, SearchBox, useDismiss } from "~/components/disclosure";

export type SelectOption = { value: string; label: string; group?: string };

// A dropdown for picking one value: the list is the site's own panel rather than the system's,
// and it works like the menus in disclosure.tsx, with the focus moving into the list. Forms get
// the value through a hidden input; `submitOnChange` sends the form as soon as something is
// picked.
export function Select({
  name,
  options,
  value,
  // Like a native <select>, the first option unless said otherwise.
  defaultValue = options.at(0)?.value ?? "",
  onValueChange,
  placeholder = "请选择",
  required,
  submitOnChange,
  className,
  "aria-label": label,
}: {
  name?: string;
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  submitOnChange?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useDismiss(open, () => setOpen(false), root);
  const chosen = options.find((o) => o.value === current);
  const searchable = options.length >= SEARCH_FROM;
  const shown = matching(options, query);

  // Like a menu: opening puts the focus on the chosen item, or in the search box.
  useEffect(() => {
    if (!open || searchable) return;
    const items = list.current?.querySelectorAll("button");
    (list.current?.querySelector<HTMLButtonElement>("[aria-current]") ?? items?.[0])?.focus();
  }, [open, searchable]);

  function show() {
    const box = button.current?.getBoundingClientRect();
    // Upwards when the list would run off the bottom and there is more room above.
    const below = box ? innerHeight - box.bottom : innerHeight;
    setUp(below < 300 && box !== undefined && box.top > below);
    setQuery("");
    setOpen(true);
  }

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function pick(next: string) {
    close();
    if (next === current) return;
    // The hidden input has to hold the new value before the form is sent.
    flushSync(() => setOwn(next));
    onValueChange?.(next);
    if (submitOnChange) input.current?.form?.requestSubmit();
  }

  function onItemKey(e: KeyboardEvent<HTMLButtonElement>) {
    const items = [...(list.current?.querySelectorAll("button") ?? [])];
    const at = items.indexOf(e.currentTarget);
    const to = new Map([
      ["ArrowDown", at + 1],
      ["ArrowUp", at - 1],
      ["Home", 0],
      ["End", items.length - 1],
    ]).get(e.key);
    if (to !== undefined) {
      e.preventDefault();
      if (to < 0 && searchable) list.current?.querySelector("input")?.focus();
      else items.at(Math.min(Math.max(to, 0), items.length - 1))?.focus();
    } else if (e.key === "Escape") {
      // Only the list closes, not a dialog it is in.
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={root} className={cn("relative", className)}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent pr-2 pl-2.5 text-left text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 md:text-sm dark:bg-input/30"
      >
        <span className={cn("flex-1 truncate", !chosen && "text-muted-foreground")}>
          {chosen ? chosen.label : placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {name && (
        // Takes part in form validation, which a type="hidden" input doesn't; the browser's
        // message then points at the button.
        <input
          ref={input}
          name={name}
          value={current}
          required={required}
          onChange={() => {}}
          onFocus={() => button.current?.focus()}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0"
        />
      )}
      {open && (
        <div
          ref={list}
          className={cn(
            "absolute z-50 flex max-h-72 min-w-full flex-col overflow-y-auto rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-lg animate-in fade-in zoom-in-95",
            up ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {searchable && (
            <SearchBox
              value={query}
              onChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  list.current?.querySelector("button")?.focus();
                } else if (e.key === "Enter") {
                  // Not the form's submit: the first match is what was meant.
                  e.preventDefault();
                  if (shown.length > 0) pick(shown[0].value);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                }
              }}
            />
          )}
          {shown.map((o, i) => (
            <Fragment key={o.value}>
              {o.group !== undefined && (i === 0 || o.group !== shown[i - 1].group) && (
                <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">{o.group}</div>
              )}
              <button
                type="button"
                aria-current={o === chosen || undefined}
                onClick={() => pick(o.value)}
                onKeyDown={onItemKey}
                className={cn(menuItem, "whitespace-nowrap outline-none focus:bg-accent")}
              >
                <span className="flex-1">{o.label}</span>
                {o === chosen && <Check />}
              </button>
            </Fragment>
          ))}
          {shown.length === 0 && <p className="px-2.5 py-1.5 text-muted-foreground">没有匹配的</p>}
        </div>
      )}
    </div>
  );
}
