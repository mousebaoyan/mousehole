import type * as React from "react";
import { cn } from "~/cn";
import { Check } from "~/components/icons";

// Native inputs drawn by the site instead of the system, so forms keep working as they are.
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <span className={cn("relative inline-flex size-4 shrink-0", className)}>
      <input
        type="checkbox"
        className="peer size-4 appearance-none rounded-[4px] border border-input bg-background transition-colors outline-none checked:border-primary checked:bg-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
        {...props}
      />
      <Check className="pointer-events-none absolute inset-0.5 size-3 stroke-3 text-primary-foreground opacity-0 peer-checked:opacity-100" />
    </span>
  );
}

function Radio({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="radio"
      className={cn(
        "size-4 shrink-0 appearance-none rounded-full border border-input bg-background transition-all outline-none checked:border-[5px] checked:border-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { Checkbox, Radio };
