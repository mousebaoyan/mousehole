import { Link } from "react-router";
import { cn } from "cn";
import { Award } from "~/components/icons";

// Badge tiers by colour (design §8.8).
export const TIER_STYLES: Record<string, string> = {
  gold: "bg-gold/15 text-gold",
  silver: "bg-silver/15 text-silver",
  bronze: "bg-bronze/15 text-bronze",
};

// How many have a badge and how much of the membership that is.
export function holdersText(count: number, rate: number) {
  if (count === 0) return "暂无人获得";
  const percent = rate * 100;
  const share =
    percent < 0.1 ? "<0.1%" : percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
  return `${count} 人获得 · ${share}`;
}

export function BadgeChip({
  badge,
  className,
}: {
  badge: { id: number; name: string; tier: string };
  className?: string;
}) {
  return (
    <Link
      to={`/badges/${badge.id}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap hover:opacity-80",
        TIER_STYLES[badge.tier],
        className,
      )}
    >
      <Award className="size-3.5" aria-hidden /> {badge.name}
    </Link>
  );
}
