// A page's title, and the card QQ and others show for a link to it (design §8.5). The site name
// and image are the same everywhere, in the root layout.
export function shareMeta(name: string, description: string, title = `${name} · 鼠洞`) {
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: name },
    { property: "og:description", content: description },
  ];
}
