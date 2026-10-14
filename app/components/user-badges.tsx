import type { UserBrief } from "~/api-types";

// The custom title, the same as what members see in the QQ group.
export function UserBadges({ user, op }: { user: UserBrief; op?: boolean }) {
  return (
    <>
      {user.title && (
        <span className="rounded border px-1.5 py-px text-2xs text-muted-foreground">
          {user.title}
        </span>
      )}
      {op && (
        <span className="rounded bg-primary px-1.5 py-px text-2xs font-medium text-primary-foreground">
          楼主
        </span>
      )}
    </>
  );
}
