import { pageTitle } from "~/share-meta";
import { apiContext } from "../../api.server.ts";
import { Input } from "~/components/ui/input";
import type { Route } from "./+types/site.ts";
import { Check, Field, readForm, Section } from "~/components/form-parts";
import { SettingsForm } from "~/components/settings-form";
import { BOT_NAME } from "../../../server/platform/site.ts";

export function meta() {
  return [{ title: pageTitle("站点", "管理后台") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin.settings.$get();
  if (!res.ok) throw new Error("Admin settings failed");
  const { site, login, bot } = await res.json();
  return { site, login, bot };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const on = (name: string) => field(name) === "on";
  const res = await context.get(apiContext).admin.settings.$patch({
    json: {
      site: {
        banner: field("banner"),
        qq_public: on("qq_public"),
      },
      login: {
        code: on("code"),
        link: on("link"),
        email: on("email"),
        code_hint: field("code_hint"),
      },
      bot: { require_operator: on("require_operator") },
    },
  });
  if (res.ok) return { ok: true, message: "已保存，立即生效" };
  return { ok: false, message: (await res.json()).error.message };
}

export default function Site({
  loaderData: { site, login, bot },
  actionData,
}: Route.ComponentProps) {
  return (
    <SettingsForm result={actionData}>
      <h1 className="text-xl font-semibold">站点</h1>

      <Section title="通用">
        <div className="flex flex-col gap-4">
          <Field label="公告横幅" hint="显示在每个论坛页面的顶部，最多 200 个字；留空不显示">
            <Input name="banner" defaultValue={site.banner} maxLength={200} />
          </Field>
          <Check
            name="qq_public"
            label="访客也能看到 QQ 号"
            hint="默认只有成员和 bot 能看到；开启后，个人资料中的 QQ 号对所有人公开"
            checked={site.qq_public}
          />
        </div>
      </Section>

      <Section title="登录方式" description="关闭的方式不在登录页显示，对应接口也会拒绝请求">
        <Check
          name="code"
          label="口令登录"
          hint={`私聊${BOT_NAME} 发送网页上显示的口令`}
          checked={login.code}
        />
        <Check
          name="link"
          label="链接登录"
          hint={`私聊${BOT_NAME} 发送「登录」，获取一次性登录链接`}
          checked={login.link}
        />
        <Check
          name="email"
          label="QQ 邮箱验证码"
          hint="需先在「邮件」中配置发信邮箱，否则不显示"
          checked={login.email}
        />
        <div className="mt-3">
          <Field label="口令提示" hint="显示在口令上方，{code} 会换成口令">
            <Input name="code_hint" defaultValue={login.code_hint} maxLength={100} />
          </Field>
        </div>
      </Section>

      <Section title="bot">
        <Check
          name="require_operator"
          label="代表成员操作时必须带 X-Operator"
          hint="开启后，bot 代表成员操作的请求必须指明发起人；成员同步等 bot 自身的操作不受影响"
          checked={bot.require_operator}
        />
      </Section>
    </SettingsForm>
  );
}
