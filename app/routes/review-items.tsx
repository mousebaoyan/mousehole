import { Check, Eye, EyeOff } from "lucide-react";
import { menuItem } from "~/components/disclosure";
import { promptDialog } from "~/components/ui/dialog";

export type Review = { status: "visible" | "hidden"; reason: string };

// What a moderator can do to a thread or floor in each state, as menu items; see design §8.4.
// Hiding asks for a reason, which the author is told.
export function ReviewItems({
  status,
  close,
  onReview,
}: {
  status: string;
  close: () => void;
  onReview: (review: Review) => void;
}) {
  async function review(to: Review["status"]) {
    close();
    const reason =
      to === "hidden"
        ? await promptDialog(
            "理由会通知作者，可不填。",
            "理由",
            status === "pending" ? "不通过" : "隐藏",
          )
        : "";
    if (reason !== null) onReview({ status: to, reason: reason.trim() });
  }
  if (status === "pending") {
    return (
      <>
        <button type="button" className={menuItem} onClick={() => review("visible")}>
          <Check /> 通过审核
        </button>
        <button type="button" className={menuItem} onClick={() => review("hidden")}>
          <EyeOff /> 不通过
        </button>
      </>
    );
  }
  return status === "hidden" ? (
    <button type="button" className={menuItem} onClick={() => review("visible")}>
      <Eye /> 恢复显示
    </button>
  ) : (
    <button type="button" className={menuItem} onClick={() => review("hidden")}>
      <EyeOff /> 隐藏
    </button>
  );
}
