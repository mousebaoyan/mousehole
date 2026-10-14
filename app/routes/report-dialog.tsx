import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import { Radio } from "~/components/ui/checkbox";
import { Dialog } from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";

const REASONS = ["垃圾广告", "人身攻击", "违法违规", "其他"];

// What a report is about: a floor, or a boost under one.
export type ReportTarget = { postId: number; label: string } | { boostId: number; label: string };

// A native <dialog> for reporting to the moderators, open while it is mounted; after sending it
// says so, or why not.
export function ReportDialog({
  threadId,
  target,
  onClose,
}: {
  threadId: number;
  target: ReportTarget;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const sending = useFetcher<{ ok: boolean; message: string }>();
  const result = sending.state === "idle" ? sending.data : undefined;
  return (
    <Dialog ref={ref} onClose={onClose}>
      <h2 className="font-semibold">举报{target.label}</h2>
      {result?.ok ? (
        <form method="dialog">
          <output className="mt-4 block text-sm">{result.message}</output>
          <div className="mt-4 flex justify-end">
            <Button>好的</Button>
          </div>
        </form>
      ) : (
        // Nothing on the page changes, so it isn't loaded again; that would also close this.
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sending.submit(e.currentTarget, {
              method: "post",
              action: `/t/${threadId}`,
              defaultShouldRevalidate: false,
            });
          }}
        >
          <input type="hidden" name="intent" value="report" />
          {"postId" in target ? (
            <input type="hidden" name="post_id" value={target.postId} />
          ) : (
            <input type="hidden" name="boost_id" value={target.boostId} />
          )}
          <fieldset className="mt-4 grid grid-cols-2 gap-2">
            <legend className="sr-only">原因</legend>
            {REASONS.map((reason) => (
              <label
                key={reason}
                className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-checked:border-brand has-checked:bg-brand/10"
              >
                <Radio name="reason" value={reason} required className="checked:border-brand" />
                {reason}
              </label>
            ))}
          </fieldset>
          <Textarea
            name="note"
            aria-label="补充说明"
            placeholder="补充说明（选填）"
            maxLength={150}
            className="mt-3 min-h-20"
          />
          {result && (
            <p role="alert" className="mt-2 text-meta text-destructive">
              {result.message}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={(e) => e.currentTarget.closest("dialog")?.close()}
            >
              取消
            </Button>
            <Button type="submit" disabled={sending.state !== "idle"}>
              提交
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
