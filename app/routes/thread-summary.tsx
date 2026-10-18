import { Link } from "react-router";
import { ChevronDown, Sparkle } from "~/components/icons";
import type { ThreadDetail } from "~/api-types";

type Summary = NonNullable<ThreadDetail["summary"]>;

// The AI's summary of a busy thread (design §8.18): folded to what the talk is about until
// opened, then each point with the floors it came from.
export function ThreadSummary({ summary }: { summary: Summary }) {
  return (
    <details className="group mt-4 rounded-2xl border bg-card">
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/12 text-brand-strong">
          <Sparkle className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-meta font-medium text-brand-strong">AI 总结</span>
          <span className="mt-0.5 line-clamp-2 text-body text-pretty group-open:line-clamp-none">
            {summary.lead}
          </span>
        </span>
        <ChevronDown
          aria-label="展开"
          className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="pr-4 pb-3.5 pl-13">
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm leading-relaxed marker:text-muted-foreground/60">
          {summary.points.map((p) => (
            <li key={p.text} className="text-pretty">
              {p.text}
              {p.floors.map((floor) => (
                <Link
                  key={floor}
                  to={`?floor=${floor}`}
                  title={`查看 #${floor}`}
                  className="ml-1.5 inline-block rounded-md bg-secondary px-1.5 text-xs leading-5 text-muted-foreground tabular-nums hover:text-foreground"
                >
                  #{floor}
                </Link>
              ))}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          由 AI 根据 {summary.replies} 条回复整理，可能有误
        </p>
      </div>
    </details>
  );
}
