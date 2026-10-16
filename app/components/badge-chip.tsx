import { Link } from "react-router";
import { cn } from "cn";
import { Award } from "~/components/icons";

// Badge tiers by colour (design §8.8).
export const TIER_STYLES: Record<string, string> = {
  gold: "bg-gold/15 text-gold",
  silver: "bg-silver/15 text-silver",
  bronze: "bg-bronze/15 text-bronze",
};

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
