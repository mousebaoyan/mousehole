import { useState, type ReactNode } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router";

// Each page fades in as it's opened from another by a link, not on the first load, whose
// navigation type is POP on the server and in the browser alike, nor going back. Keyed by the
// path, so the new page is mounted afresh and plays it; a change of filters on the same page
// doesn't.
export function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Page key={pathname}>{children}</Page>;
}

// Settled when the page mounts: the first change of filters on a page loaded by POP makes the
// navigation type PUSH, and adding the class then would play the fade-in on the same page.
function Page({ children }: { children: ReactNode }) {
  const navigationType = useNavigationType();
  const [opened] = useState(navigationType !== NavigationType.Pop);
  return <div className={opened ? "page-in" : undefined}>{children}</div>;
}
