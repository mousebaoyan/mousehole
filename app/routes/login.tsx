import {
  Link2,
  LoaderCircle,
  Mail,
  MessageSquareCode,
  MessageCircle,
  Smartphone,
} from "lucide-react";
import { LogoMark } from "~/components/logo";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

export function meta() {
  return [{ title: "登录 · 鼠洞" }];
}

export default function Login() {
  return (
    <>
      <LogoMark className="size-12" />
      <h1 className="mt-4 text-xl font-semibold">登录鼠洞</h1>
      <p className="mt-1 text-sm text-muted-foreground">仅限鼠群成员，使用 QQ 号登录</p>
      <div className="mt-6 w-full max-w-sm rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <Tabs defaultValue="code">
          <TabsList className="w-full">
            <TabsTrigger value="code">
              <MessageSquareCode /> 口令
            </TabsTrigger>
            <TabsTrigger value="email">
              <Mail /> QQ 邮箱
            </TabsTrigger>
            <TabsTrigger value="link">
              <Link2 /> 链接
            </TabsTrigger>
          </TabsList>

          <TabsContent value="code" className="pt-4">
            <p className="text-sm text-muted-foreground">私聊机器人发送</p>
            <div className="mt-2 rounded-xl bg-secondary py-4 text-center">
              <span className="text-sm text-muted-foreground">登录 </span>
              <span className="font-mono text-3xl font-semibold tracking-[0.2em]">482913</span>
            </div>
            <div className="mt-3 flex items-center justify-between text-meta text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle className="size-3.5 animate-spin" /> 等待确认
              </span>
              <span className="tabular-nums">04:32</span>
            </div>
          </TabsContent>

          <TabsContent value="email" className="flex flex-col gap-3 pt-4">
            <div className="flex gap-2">
              <Input inputMode="numeric" placeholder="QQ 号" />
              <Button variant="outline" className="shrink-0">
                发送验证码
              </Button>
            </div>
            <Input inputMode="numeric" placeholder="验证码" maxLength={6} />
            <Button className="w-full">登录</Button>
            <p className="text-meta text-muted-foreground">验证码发送至 QQ 邮箱，10 分钟内有效</p>
          </TabsContent>

          <TabsContent value="link" className="pt-4">
            <ol className="flex flex-col gap-3 text-sm">
              <li className="flex items-center gap-3">
                <MessageCircle className="size-5 shrink-0 text-brand-strong" />
                <span>
                  私聊机器人发送<span className="mx-1 font-medium">登录链接</span>
                </span>
              </li>
              <li className="flex items-center gap-3">
                <Smartphone className="size-5 shrink-0 text-brand-strong" />
                在手机 QQ 中打开收到的链接
              </li>
            </ol>
            <p className="mt-4 text-meta text-muted-foreground">链接 10 分钟内有效，仅可使用一次</p>
          </TabsContent>
        </Tabs>
      </div>
      <a
        href="https://mousebaoyan.cn/join"
        className="mt-6 text-meta text-muted-foreground hover:text-foreground"
      >
        加入鼠群
      </a>
    </>
  );
}
