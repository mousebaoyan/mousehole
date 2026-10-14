import { Check, ChevronDown } from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { cn } from "cn";
import { Dropdown, matching, menuItem, SEARCH_FROM, SearchBox } from "~/components/disclosure";

export const FILTER =
  "inline-flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 text-sm hover:bg-accent";

export type FilterChoice = {
  to: string;
  label: string;
  chosen: boolean;
  group?: string;
  // A board's dot.
  color?: string;
};

// A pill that opens links to the same page with one filter changed, so the filters live in the
// address and can be shared. The thread lists and search use it.
export function FilterMenu({
  label,
  trigger,
  choices,
}: {
  label: string;
  trigger: ReactNode;
  choices: FilterChoice[];
}) {
  const { key } = useLocation();
  return (
    <Dropdown
      key={key}
      label={label}
      align="start"
      triggerClassName={FILTER}
      trigger={
        <>
          {trigger}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </>
      }
    >
      {() => <Choices choices={choices} />}
    </Dropdown>
  );
}

function Choices({ choices }: { choices: FilterChoice[] }) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const shown = matching(choices, query);
  return (
    <div ref={list}>
      {choices.length >= SEARCH_FROM && (
        <SearchBox
          value={query}
          onChange={setQuery}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              list.current?.querySelector("a")?.focus();
            } else if (e.key === "Enter" && shown.length > 0) {
              void navigate(shown[0].to);
            }
          }}
        />
      )}
      {shown.map((c, i) => (
        <Fragment key={c.to}>
          {c.group !== undefined && (i === 0 || c.group !== shown[i - 1].group) && (
            <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">{c.group}</div>
          )}
          <Link to={c.to} className={cn(menuItem, c.chosen && "font-medium")}>
            {c.color !== undefined && <Dot color={c.color} />}
            {c.label}
            {c.chosen && <Check className="ml-auto" />}
          </Link>
        </Fragment>
      ))}
      {shown.length === 0 && <p className="px-2.5 py-1.5 text-muted-foreground">没有匹配的</p>}
    </div>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}
