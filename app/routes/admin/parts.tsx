import type { ReactNode } from "react";
import { cn } from "cn";

// Shared by the admin pages.

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-6 rounded-2xl border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      {description && <p className="mt-1 text-meta text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-meta text-muted-foreground">{hint}</span>}
    </label>
  );
}

// What an action said: saved, or why not.
export function Result({ result }: { result: { ok: boolean; message: string } | undefined }) {
  if (!result) return null;
  return (
    <p
      role={result.ok ? "status" : "alert"}
      className={cn("text-meta", result.ok ? "text-success" : "text-destructive")}
    >
      {result.message}
    </p>
  );
}

const TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// In Beijing time, so the server and the browser render the same text.
export function Time({ value, never = "—" }: { value: number | null; never?: string }) {
  if (value === null) return <>{never}</>;
  const date = new Date(value * 1000);
  return <time dateTime={date.toISOString()}>{TIME.format(date)}</time>;
}

export async function readForm(request: Request) {
  const form = await request.formData();
  return (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
}
