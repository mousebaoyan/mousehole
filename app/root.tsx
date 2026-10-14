import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import { use } from "react";
import type { Route } from "./+types/root.ts";
import { Nonce } from "./nonce.ts";
import { SITE_URL } from "./site.server.ts";
import { buttonVariants } from "~/components/ui/button";
import { DialogHost } from "~/components/ui/dialog";
import { Toaster } from "~/components/ui/toast";
import "./app.css";
import { SITE_NAME } from "../server/platform/site.ts";

// Runs before first paint so the page never flashes the wrong theme. Same key as the main site.
const themeScript = `try{document.documentElement.dataset.theme=localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}catch{}`;

export function loader() {
  return { site: SITE_URL };
}

// The site's address doesn't change.
export function shouldRevalidate() {
  return false;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const nonce = use(Nonce);
  // Missing when the page failed before the root loader ran.
  const site = useRouteLoaderData<typeof loader>("root")?.site;
  return (
    // themeScript sets data-theme before hydration; this only silences that one attribute.
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#fefdfb" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#161b1a" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta property="og:site_name" content={SITE_NAME} />
        {site && <meta property="og:image" content={`${site}/logo.png`} />}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <DialogHost />
        <Toaster />
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

const TITLES: Partial<Record<number, string>> = {
  401: "登录后查看",
  403: "没有权限",
  404: "页面不存在",
};

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const response = isRouteErrorResponse(error) ? error : null;
  const title = (response && TITLES[response.status]) ?? "出错了";
  const detail =
    typeof response?.data === "string"
      ? response.data
      : response?.status === 404
        ? "链接有误，或内容已被删除。"
        : "请稍后重试。";
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted-foreground">{detail}</p>
      {response?.status === 401 && (
        <Link to="/login" className={buttonVariants({ className: "mt-4" })}>
          登录
        </Link>
      )}
    </main>
  );
}
