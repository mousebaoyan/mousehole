import { Ban, MicOff, ShieldCheck } from "lucide-react";
import { useRef } from "react";
import { Form } from "react-router";
import { Field } from "~/components/form-parts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import type { Restriction } from "~/restriction";

const DAYS = [
  { days: 1, label: "1 天" },
  { days: 3, label: "3 天" },
  { days: 7, label: "7 天" },
  { days: 30, label: "30 天" },
  { days: 0, label: "永久" },
];

// What staff can do about a member on their page: mute, ban (admins), or lift either. See
// design §6.4. Only ordinary members can be restricted.
export function ModerationButtons({
  restriction,
  admin,
}: {
  restriction: Restriction | null;
  admin: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  if (restriction) {
    return (
      <Form method="post" className="mt-3">
        <input type="hidden" name="intent" value="lift" />
        <Button
          variant="outline"
          size="sm"
          disabled={restriction.type === "ban" && !admin}
          title={restriction.type === "ban" && !admin ? "只有管理员能解除封禁" : undefined}
        >
          <ShieldCheck /> 解除{restriction.type === "ban" ? "封禁" : "禁言"}
        </Button>
      </Form>
    );
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => dialog.current?.showModal()}
      >
        <MicOff /> 禁言{admin && "或封禁"}
      </Button>
      <dialog
        ref={dialog}
        className="m-auto w-[min(24rem,calc(100%-2rem))] rounded-2xl border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/30"
      >
        <Form method="post" onSubmit={() => dialog.current?.close()}>
          <input type="hidden" name="intent" value="restrict" />
          <h2 className="font-semibold">{admin ? "禁言或封禁" : "禁言"}</h2>
          <p className="mt-1 text-meta text-muted-foreground">
            禁言后还能浏览，但不能发帖、回复、点赞和短评；封禁后不能登录
          </p>
          {admin && (
            <fieldset className="mt-4 grid grid-cols-2 gap-2 text-sm">
              {[
                { type: "mute", label: "禁言", Icon: MicOff },
                { type: "ban", label: "封禁", Icon: Ban },
              ].map(({ type, label, Icon }) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 has-checked:border-brand has-checked:bg-brand/10"
                >
                  <input
                    type="radio"
                    name="type"
                    value={type}
                    defaultChecked={type === "mute"}
                    className="accent-brand"
                  />
                  <Icon className="size-4" /> {label}
                </label>
              ))}
            </fieldset>
          )}
          <div className="mt-4 flex flex-col gap-3">
            <Field label="时长">
              <NativeSelect name="days" defaultValue="1">
                {DAYS.map((d) => (
                  <option key={d.days} value={d.days}>
                    {d.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="理由">
              <Input name="reason" required maxLength={200} placeholder="记进操作日志" />
            </Field>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
              取消
            </Button>
            <Button type="submit" variant="destructive">
              确定
            </Button>
          </div>
        </Form>
      </dialog>
    </>
  );
}
