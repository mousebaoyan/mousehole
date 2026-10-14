import { SITE_NAME } from "../server/platform/site.ts";

// A page's title, and the card QQ and others show for a link to it (design §8.5). The site name
// and image are the same everywhere, in the root layout.
export function shareMeta(name: string, description: string, title = `${name} · ${SITE_NAME}`) {
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: name },
    { property: "og:description", content: description },
  ];
}
