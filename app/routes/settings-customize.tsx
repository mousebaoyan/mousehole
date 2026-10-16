import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "cn";
import { Award } from "~/components/icons";
import { TIER_STYLES } from "~/components/badge-chip";
import { Select } from "~/components/ui/select";

// The settings page's 个性化 section (design §8.16).

// A value of the settings form kept by a control of its own, in a hidden input. Like a native
// field, it tells the form when it changes and goes back to where it started when the form is
// reset.
function useFormValue<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return undefined;
    const reset = () => setValue(initial);
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [initial]);
  function change(next: T) {
    // The hidden input has to hold the new value before the form looks at it.
    flushSync(() => setValue(next));
    input.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { value, change, input };
}

type Badge = { id: number; name: string; tier: string };

// The most a card shows.
const SHOWN_MAX = 3;

// The badges on their card: the best ones unless they pick, in the order picked; picking none
// shows none. Sent as "auto" or the IDs.
export function ShownBadgesField({ badges, shown }: { badges: Badge[]; shown: number[] | null }) {
  const { value, change, input } = useFormValue(shown);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">展示徽章</span>
      <input
        ref={input}
        type="hidden"
        name="shown_badges"
        value={value === null ? "auto" : value.join(",")}
      />
      <Select
        aria-label="展示徽章"
        value={value === null ? "auto" : "pick"}
        onValueChange={(mode) => change(mode === "auto" ? null : (shown ?? []))}
        options={[
          { value: "auto", label: "自动：金徽章在前，同档的最近得到的在前" },
          { value: "pick", label: "自己选择" },
        ]}
      />
      {value !== null &&
        (badges.length === 0 ? (
          <span className="text-meta text-muted-foreground">得到徽章后可以在这里选择</span>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {badges.map((b) => {
                const at = value.indexOf(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={at >= 0}
                    disabled={at < 0 && value.length >= SHOWN_MAX}
                    onClick={() =>
                      change(at >= 0 ? value.filter((id) => id !== b.id) : [...value, b.id])
                    }
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-offset-2 ring-offset-card disabled:opacity-40",
                      TIER_STYLES[b.tier],
                      at >= 0 && "ring-2 ring-current",
                    )}
                  >
                    {at >= 0 ? (
                      <span className="flex size-3.5 items-center justify-center rounded-full bg-current">
                        <span className="text-[0.625rem] text-card tabular-nums">{at + 1}</span>
                      </span>
                    ) : (
                      <Award className="size-3.5" aria-hidden />
                    )}
                    {b.name}
                  </button>
                );
              })}
            </div>
            <span className="text-meta text-muted-foreground">
              最多 {SHOWN_MAX} 枚，按点选的顺序显示在资料卡和主页上；一枚都不选就不展示
            </span>
          </>
        ))}
    </div>
  );
}
