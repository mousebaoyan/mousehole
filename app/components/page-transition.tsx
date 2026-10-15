import type { ReactNode } from "react";
import { useLocation, useNavigationType } from "react-router";

// Each page fades in as it's opened from another by a link, not on the first load, whose
// navigation type is POP on the server and in the browser alike, nor going back. Keyed by the
// path, so the new page is mounted afresh and plays it; a change of filters on the same page
// doesn't.
export function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const opened = useNavigationType() !== "POP";
  return (
    <div key={pathname} className={opened ? "page-in" : undefined}>
      {children}
    </div>
  );
}
