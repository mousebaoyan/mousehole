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

// For an admin who chose to see who the anonymous people in a thread are: each shown as the
// real person, avatar, name and badges, as if they had never been anonymous.
export function useShown() {
  const revealed = use(RevealContext);
  return <T extends object>(writer: T | Anonymous): T | Anonymous | UserBrief =>
    (isAnonymous(writer) && revealed?.get(writer.number)) || writer;
}

type Anonymous = Extract<Writer, { anonymous: true }>;

function isAnonymous(writer: object): writer is Anonymous {
  return "anonymous" in writer;
}
