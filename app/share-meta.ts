import { SITE_NAME } from "../server/platform/site.ts";

// A tab's title (design §9): its parts from the most specific, then the site, "·" between.
export function pageTitle(...parts: string[]) {
  return [...parts, SITE_NAME].join(" · ");
}

// A page's title, and the card QQ and others show for a link to it (design §8.5): the card is
// titled with the first part unless told otherwise. The site name and image are the same
// everywhere, in the root layout.
export function shareMeta(parts: string[], description: string, card = parts[0]) {
  return [
    { title: pageTitle(...parts) },
    { name: "description", content: description },
    { property: "og:title", content: card },
    { property: "og:description", content: description },
  ];
}
