// Runs on install. The emoji picker loads its data from /emojibase/{version}/zh/ (see
// app/components/emoji-picker.tsx), so it is copied into public/ instead of committed.
import { cpSync, rmSync } from "node:fs";
import pkg from "emojibase-data/package.json" with { type: "json" };

rmSync("public/emojibase", { recursive: true, force: true });
for (const file of ["data.json", "messages.json"]) {
  cpSync(`node_modules/emojibase-data/zh/${file}`, `public/emojibase/${pkg.version}/zh/${file}`);
}
