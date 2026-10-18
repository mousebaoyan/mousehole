import { useRef } from "react";
import { Form, useSubmit } from "react-router";
import { Ban, Eraser, MicOff, ShieldCheck } from "~/components/icons";
import { Field } from "~/components/form-parts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Radio } from "~/components/ui/checkbox";
import { Dialog, promptDialog } from "~/components/ui/dialog";
import { Select } from "~/components/ui/select";
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
      <Dialog ref={dialog}>
        <Form method="post" onSubmit={() => dialog.current?.close()}>
          <input type="hidden" name="intent" value="restrict" />
          <h2 className="font-semibold">{admin ? "禁言或封禁" : "禁言"}</h2>
          <p className="mt-1 text-meta text-muted-foreground">
            禁言后仍可浏览，但不能发帖、回复、点赞和发短评。封禁后无法登录
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
                  <Radio
                    name="type"
                    value={type}
                    defaultChecked={type === "mute"}
                    className="checked:border-brand"
                  />
                  <Icon className="size-4" /> {label}
                </label>
              ))}
            </fieldset>
          )}
          <div className="mt-4 flex flex-col gap-3">
            <Field label="时长">
              <Select
                name="days"
                defaultValue="1"
                options={DAYS.map((d) => ({ value: String(d.days), label: d.label }))}
              />
            </Field>
            <Field label="理由">
              <Input name="reason" required maxLength={200} placeholder="将记入操作日志" />
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
      </Dialog>
    </>
  );
}

// Clearing what someone wrote about themselves when it isn't fit to show (design §8.16).
export function ClearButtons({
  name,
  background,
  status,
  showcase,
}: {
  name: string;
  background: boolean;
  status: boolean;
  showcase: boolean;
}) {
  const submit = useSubmit();
  if (!background && !status && !showcase) return null;
  async function clear(item: "background" | "status" | "showcase", what: string) {
    const reason = await promptDialog(
      `确定清除 ${name} 的${what}？清除后无法恢复，理由将记入操作日志。`,
      "理由",
      "清除",
      true,
    );
    if (reason !== null) void submit({ intent: "clear", item, reason }, { method: "post" });
  }
  return (
    <p className="mt-3 flex flex-wrap gap-2">
      {background && (
        <Button variant="outline" size="sm" onClick={() => void clear("background", "背景")}>
          <Eraser /> 清除背景
        </Button>
      )}
      {status && (
        <Button variant="outline" size="sm" onClick={() => void clear("status", "状态")}>
          <Eraser /> 清除状态
        </Button>
      )}
      {showcase && (
        <Button variant="outline" size="sm" onClick={() => void clear("showcase", "展柜")}>
          <Eraser /> 清除展柜
        </Button>
      )}
    </p>
  );
}
