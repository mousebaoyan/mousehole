import { NONCE, secureHeaders } from "hono/secure-headers";
import { env } from "./env.ts";
import { UMAMI } from "./site.ts";

const https = new URL(env.PUBLIC_URL).protocol === "https:";

// Design §13. The CSP, with a nonce for the scripts pages write inline, and HSTS come with
// HTTPS, as the site is served; local development over HTTP keeps the inline scripts Vite adds
// for hot reloading. Inline styles stay allowed for the style attributes components set.
export const securityHeaders = secureHeaders({
  contentSecurityPolicy: https
    ? {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", NONCE, UMAMI.origin],
        connectSrc: ["'self'", UMAMI.origin],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      }
    : undefined,
  strictTransportSecurity: https ? "max-age=31536000; includeSubDomains" : false,
  referrerPolicy: "strict-origin-when-cross-origin",
  xFrameOptions: "DENY",
});
