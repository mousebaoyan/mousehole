import { Download, LogOut, Monitor } from "lucide-react";
import { useState } from "react";
import { Form, redirect, useFetcher, useNavigation, useRevalidator } from "react-router";
import { apiContext } from "../api.server.ts";
import { browserApi } from "~/browser-api";
import { Check, Field, readForm, Result, Section, Time } from "~/components/form-parts";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "~/components/ui/toast";
import { UserAvatar } from "~/components/user-avatar";
import { useMe } from "~/forum";
import type { Route } from "./+types/settings.ts";
import { Checkbox } from "~/components/ui/checkbox";
import { SITE_NAME } from "../../server/platform/site.ts";

export function meta() {
  return [{ title: `设置 · ${SITE_NAME}` }];
}

// The notification types, in the order the table lists them.
const TYPES = [
  { type: "reply", label: "回复我" },
  { type: "mention", label: "@我" },
  { type: "like", label: "点赞" },
  { type: "boost", label: "短评" },
  { type: "watching", label: "关注的帖子有新回复" },
  { type: "following", label: "关注的人发新帖" },
  { type: "solved", label: "回答被采纳" },
  { type: "moderation", label: "内容被审核或隐藏" },
  { type: "level", label: "升级" },
  { type: "lottery", label: "抽奖开奖或取消" },
] as const;

export async function loader({ context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const [settings, sessions] = await Promise.all([api.me.settings.$get(), api.me.sessions.$get()]);
  if (!settings.ok || !sessions.ok) return redirect("/login");
  return { settings: await settings.json(), sessions: (await sessions.json()).items };
}

// Saving the form, or signing a device out.
export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const field = await readForm(request);
  if (field("intent") === "sign-out") {
    await api.me.sessions[":id"].$delete({ param: { id: field("id") } });
    return null;
  }
  if (field("intent") === "qq-avatar") {
    const res = await api.me.avatar.$delete();
    if (res.ok) return { ok: true, message: "头像已改回 QQ 头像" };
    return { ok: false, message: (await res.json()).error.message };
  }
  const on = (name: string) => field(name) === "on";
  const res = await api.me.$patch({
    json: {
      custom_name: field("custom_name") || null,
      custom_bio: field("custom_bio") || null,
      allow_proxy: on("allow_proxy"),
      hide_from_guests: on("hide_from_guests"),
      notify_prefs: Object.fromEntries(
        TYPES.map(({ type }) => [type, { site: on(`${type}.site`), qq: on(`${type}.qq`) }]),
      ),
    },
  });
  if (res.ok) return { ok: true, message: "已保存" };
  return { ok: false, message: (await res.json()).error.message };
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, sessions } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <div className="max-w-2xl">
      <h1 className="px-1 text-xl font-semibold">设置</h1>
      <Form method="post">
        <Section title="资料">
          <div className="flex flex-col gap-4">
            <AvatarField custom={settings.avatar_custom} />
            <Field label="名字" hint="最多 24 个字；留空就跟着 QQ 群名片">
              <Input
                name="custom_name"
                defaultValue={settings.custom_name ?? ""}
                placeholder="跟着 QQ 群名片"
                maxLength={24}
              />
            </Field>
            <Field label="个性签名" hint="最多 60 个字，显示在资料卡和个人主页上；留空就跟着 QQ">
              <Textarea
                name="custom_bio"
                defaultValue={settings.custom_bio ?? ""}
                placeholder={settings.qq_bio || "跟着 QQ 的个性签名"}
                maxLength={60}
                className="min-h-16"
              />
            </Field>
          </div>
        </Section>

        <Section title="隐私">
          <Check
            name="hide_from_guests"
            label="我的内容不给访客看"
            hint="没登录的人和搜索引擎看不到我发的帖子、回复和短评，我的主页只显示名字和头像；以前发的也算。半分钟内生效"
            checked={settings.hide_from_guests}
          />
        </Section>

        <Section title="机器人代发">
          <Check
            name="allow_proxy"
            label="允许群里的机器人代我发帖、回复和点赞"
            hint="关掉后，只有我自己在群里让机器人操作时才放行"
            checked={settings.allow_proxy}
          />
        </Section>

        <Section title="通知" description="站内通知在顶栏的铃铛里；QQ 提醒由群里的机器人发给你">
          <table className="w-full text-sm">
            <thead className="text-meta text-muted-foreground">
              <tr>
                <th className="pb-2 text-left font-normal">类型</th>
                <th className="w-16 pb-2 font-normal">站内</th>
                <th className="w-16 pb-2 font-normal">QQ 提醒</th>
              </tr>
            </thead>
            <tbody>
              {TYPES.map(({ type, label }) => (
                <tr key={type} className="border-t">
                  <td className="py-2">{label}</td>
                  {(["site", "qq"] as const).map((where) => (
                    <td key={where} className="text-center">
                      <Checkbox
                        name={`${type}.${where}`}
                        defaultChecked={settings.notify_prefs[type][where]}
                        aria-label={`${label}：${where === "site" ? "站内" : "QQ 提醒"}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <div className="mt-6 flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            保存
          </Button>
          <Result result={actionData ?? undefined} />
        </div>
      </Form>

      <Section title="登录设备" description="在别处登录过、又不再用的设备，可以让它下线">
        <ul className="divide-y">
          {sessions.map((s) => (
            <Device key={s.id} session={s} />
          ))}
        </ul>
      </Section>

      <Section
        title="导出"
        description="下载自己发过的帖子和回复（Markdown 原文）、短评和收藏，JSON 格式；每小时最多 3 次"
      >
        <a href="/api/v1/me/export" download className={buttonVariants({ variant: "outline" })}>
          <Download /> 下载我的内容
        </a>
      </Section>
    </div>
  );
}

type Session = Route.ComponentProps["loaderData"]["sessions"][number];

function Device({ session: s }: { session: Session }) {
  const signOut = useFetcher();
  return (
    <li className="flex items-center gap-3 py-3 text-sm">
      <Monitor className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {s.device}
          {s.current && <span className="ml-2 text-meta text-success">当前设备</span>}
        </p>
        <p className="text-meta text-muted-foreground">
          最近使用 <Time value={s.last_seen_at} />
          {s.ip && ` · ${s.ip}`}
        </p>
      </div>
      {!s.current && (
        <signOut.Form method="post">
          <input type="hidden" name="intent" value="sign-out" />
          <input type="hidden" name="id" value={s.id} />
          <Button variant="ghost" size="sm" disabled={signOut.state !== "idle"}>
            <LogOut /> 下线
          </Button>
        </signOut.Form>
      )}
    </li>
  );
}

// The picture goes straight to /api/v1, like images in posts; the page then loads again, and the
// header shows the new avatar too. Going back to the QQ one is a submit of the settings form.
function AvatarField({ custom }: { custom: boolean }) {
  const me = useMe();
  const { revalidate } = useRevalidator();
  const [uploading, setUploading] = useState(false);
  if (!me) return null;

  async function upload(file: File) {
    setUploading(true);
    const res = await browserApi.me.avatar.$put({ form: { file } });
    if (res.ok) await revalidate();
    else toast((await res.json()).error.message);
    setUploading(false);
  }

  return (
    <div className="flex items-center gap-4">
      <UserAvatar user={me} className="size-16 text-lg" />
      <div className="flex flex-wrap items-center gap-2">
        <label
          className={buttonVariants({
            variant: "outline",
            size: "sm",
            className: "cursor-pointer has-disabled:pointer-events-none has-disabled:opacity-50",
          })}
        >
          {uploading ? "上传中…" : "上传头像"}
          <input
            type="file"
            accept="image/*"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
            className="sr-only"
          />
        </label>
        {custom && (
          <Button type="submit" name="intent" value="qq-avatar" variant="ghost" size="sm">
            改回 QQ 头像
          </Button>
        )}
      </div>
    </div>
  );
}
