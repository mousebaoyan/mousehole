import { Download, LogOut, Monitor } from "lucide-react";
import { useEffect, useState } from "react";
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
  { type: "reply", label: "回复我的楼层" },
  { type: "thread_reply", label: "回复我的帖子（没指定回复哪一层）" },
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

// The page's sections, for the navigation beside them.
const SECTIONS = {
  profile: { id: "profile", title: "资料" },
  privacy: { id: "privacy", title: "隐私" },
  proxy: { id: "proxy", title: "群聊收录" },
  notify: { id: "notify", title: "通知" },
  devices: { id: "devices", title: "登录设备" },
  export: { id: "export", title: "导出" },
};

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
      relations_public: on("relations_public"),
      notify_email: on("notify_email"),
      notify_prefs: Object.fromEntries(
        TYPES.map(({ type }) => [type, { site: on(`${type}.site`), email: on(`${type}.email`) }]),
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
    <div className="flex gap-8">
      <div className="max-w-2xl min-w-0 flex-1">
        <h1 className="px-1 text-xl font-semibold">设置</h1>
        <nav aria-label="设置的分类" className="mt-3 flex gap-1 overflow-x-auto xl:hidden">
          {Object.values(SECTIONS).map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="shrink-0 rounded-full border px-3 py-1 text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {s.title}
            </a>
          ))}
        </nav>
        <Form method="post">
          <Section {...SECTIONS.profile}>
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

          <Section {...SECTIONS.privacy}>
            <Check
              name="hide_from_guests"
              label="我的内容不给访客看"
              hint="没登录的人和搜索引擎看不到我发的帖子、回复和短评，我的主页只显示名字和头像；以前发的也算。半分钟内生效"
              checked={settings.hide_from_guests}
            />
            <Check
              name="relations_public"
              label="公开我的赞和关系"
              hint="其他成员能在我的主页看到我赞过的楼层、我关注和认可的人、我的粉丝，我也会出现在别人主页的这些名单里。关掉后数字照常显示"
              checked={settings.relations_public}
            />
          </Section>

          <Section {...SECTIONS.proxy}>
            <Check
              name="allow_proxy"
              label="允许把我在群里的提问和回答整理到论坛"
              hint="整理好的内容记在我名下，我可以编辑和删除。关掉后，我在群里说的话不会再收录"
              checked={settings.allow_proxy}
            />
          </Section>

          <Section {...SECTIONS.notify} description="站内通知在顶栏的铃铛里，邮件发到你的 QQ 邮箱">
            <Check
              name="notify_email"
              label="接收邮件提醒"
              hint="关掉后哪类通知都不发邮件，下面各类的设置会保留"
              checked={settings.notify_email}
            />
            <table className="mt-3 w-full text-sm">
              <thead className="text-meta text-muted-foreground">
                <tr>
                  <th className="pb-2 text-left font-normal">类型</th>
                  <th className="w-16 pb-2 font-normal">站内</th>
                  <th className="w-16 pb-2 font-normal">邮件</th>
                </tr>
              </thead>
              <tbody>
                {TYPES.map(({ type, label }) => (
                  <tr key={type} className="border-t">
                    <td className="py-2">{label}</td>
                    {(["site", "email"] as const).map((where) => (
                      <td key={where}>
                        {/* The whole cell takes the tap, not just the 16px box. */}
                        <label className="flex h-10 cursor-pointer items-center justify-center">
                          <Checkbox
                            name={`${type}.${where}`}
                            defaultChecked={settings.notify_prefs[type][where]}
                            aria-label={`${label}：${where === "site" ? "站内" : "邮件"}`}
                          />
                        </label>
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

        <Section {...SECTIONS.devices} description="在别处登录过、又不再用的设备，可以让它下线">
          <ul className="divide-y">
            {sessions.map((s) => (
              <Device key={s.id} session={s} />
            ))}
          </ul>
        </Section>

        <Section
          {...SECTIONS.export}
          description="下载自己发过的帖子和回复（Markdown 原文）、短评和收藏，JSON 格式；每小时最多 3 次"
        >
          <a href="/api/v1/me/export" download className={buttonVariants({ variant: "outline" })}>
            <Download /> 下载我的内容
          </a>
        </Section>
      </div>
      <aside className="hidden w-44 shrink-0 xl:block">
        <SectionNav />
      </aside>
    </div>
  );
}

// Section headings at or above this line of the viewport count as reached (header plus some air).
const REACHED_LINE = 120;

function SectionNav() {
  const sections = Object.values(SECTIONS);
  const [current, setCurrent] = useState<string>(SECTIONS.profile.id);
  useEffect(() => {
    function update() {
      const { scrollHeight } = document.documentElement;
      // The last sections are short and may never reach the line before the page ends.
      if (innerHeight + scrollY >= scrollHeight - 1) {
        setCurrent(SECTIONS.export.id);
        return;
      }
      const reached = Object.values(SECTIONS).filter((s) => {
        const heading = document.getElementById(s.id);
        return heading !== null && heading.getBoundingClientRect().top <= REACHED_LINE;
      });
      setCurrent((reached.at(-1) ?? SECTIONS.profile).id);
    }
    update();
    addEventListener("scroll", update, { passive: true });
    return () => removeEventListener("scroll", update);
  }, []);
  return (
    <nav aria-label="设置的分类" className="sticky top-20 flex flex-col gap-0.5 text-sm">
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={s.id === current ? "location" : undefined}
          className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground aria-[current]:bg-accent aria-[current]:font-medium aria-[current]:text-foreground"
        >
          {s.title}
        </a>
      ))}
    </nav>
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
