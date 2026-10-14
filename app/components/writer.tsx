import { createContext, use } from "react";
import type { UserBrief, Writer } from "~/api-types";

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
