import { createContext, use } from "react";
import type { UserBrief, Writer } from "~/api-types";
import { STAFF } from "../../server/platform/site.ts";

// Who each number in a thread is, for an admin who chose to see it there (design §8.12).
export const RevealContext = createContext<Map<number, UserBrief> | null>(null);

// Whether something was written by the reader: by their ID, or by their number in the thread.
export function isMine(
  writer: { anonymous: true; number: number } | { id: number },
  me: { id: number } | null,
  myAlias: number | null,
) {
  return "anonymous" in writer ? writer.number === myAlias : writer.id === me?.id;
}

// What the reader's level lets them do to someone else's content, as the server decides it
// (design §6.6): their level, from L3 up, over people below it who aren't moderators or admins,
// else 0. Nothing anonymous.
export function levelPower(writer: Writer, me: { id: number; level: number } | null) {
  if (!me || me.level < 3 || "anonymous" in writer || writer.id === me.id) return 0;
  const staff = STAFF.includes(writer.role);
  return writer.level < me.level && !staff ? me.level : 0;
}

export function sameWriter(a: Writer, b: Writer) {
  if ("anonymous" in a) return "anonymous" in b && a.number === b.number;
  return !("anonymous" in b) && a.id === b.id;
}

// The name as shown, and for an admin who chose to, who it really is.
export function WriterName({ writer }: { writer: Writer }) {
  const revealed = use(RevealContext);
  const real = "anonymous" in writer ? revealed?.get(writer.number) : undefined;
  return (
    <>
      {writer.display_name}
      {real && <span className="ml-1 font-normal text-destructive">（{real.display_name}）</span>}
    </>
  );
}
