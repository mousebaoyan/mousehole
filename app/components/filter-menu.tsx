import { Check, ChevronDown } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { cn } from "cn";
import { Dropdown, menuItem } from "~/components/disclosure";

export const FILTER =
  "inline-flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 text-sm hover:bg-accent";

export type FilterChoice = { to: string; label: ReactNode; chosen: boolean; group?: string };

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
      {() =>
        choices.map((c, i) => (
          <Fragment key={c.to}>
            {c.group !== undefined && (i === 0 || c.group !== choices[i - 1].group) && (
              <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">{c.group}</div>
            )}
            <Link to={c.to} className={cn(menuItem, c.chosen && "font-medium")}>
              {c.label}
              {c.chosen && <Check className="ml-auto" />}
            </Link>
          </Fragment>
        ))
      }
    </Dropdown>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}
