import { cn } from "~/cn";
import type * as React from "react";

// The class for each look, defined in app.css.
const VARIANTS = {
  default: "btn-primary",
  outline: "btn-outline",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  destructive: "btn-destructive",
  link: "btn-link",
};

const SIZES = {
  default: "btn-md",
  xs: "btn-xs",
  sm: "btn-sm",
  lg: "btn-lg",
  icon: "btn-icon",
  "icon-xs": "btn-icon-xs",
  "icon-sm": "btn-icon-sm",
  "icon-lg": "btn-icon-lg",
};

type Looks = { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; className?: string };

function buttonVariants({ variant = "default", size = "default", className }: Looks = {}) {
  return cn("btn", VARIANTS[variant], SIZES[size], className);
}

// A plain <button>: it is on every page, and Base UI's Button would add ~14KB gzip of
// shared code for focus features we don't use.
function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"button"> & Omit<Looks, "className">) {
  return (
    <button
      data-slot="button"
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  );
}

export { Button, buttonVariants };
