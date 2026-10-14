import { Link2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";

export function CopyLinkButton({ path, size }: { path: string; size: "icon-sm" | "icon-lg" }) {
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label="复制链接"
      title="复制链接"
      // QQ's built-in browser can refuse the clipboard.
      onClick={() =>
        void navigator.clipboard.writeText(new URL(path, location.origin).href).then(
          () => toast("链接已复制"),
          () => toast("复制失败，请从地址栏复制"),
        )
      }
    >
      <Link2 />
    </Button>
  );
}
