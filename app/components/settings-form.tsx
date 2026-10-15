import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, useBlocker, useNavigation } from "react-router";
import { Button } from "~/components/ui/button";
import { chooseDialog } from "~/components/ui/dialog";
import { toast } from "~/components/ui/toast";

type Result = { ok: boolean; message: string };

// What the form holds, to tell whether it differs from what was saved.
function snapshot(form: HTMLFormElement) {
  return JSON.stringify(
    [...new FormData(form)].map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.name,
    ]),
  );
}

// A form of settings, posted to the page's action. Once something differs from what was saved, a
// bar rises from the bottom to save or undo it; leaving the page, or closing or reloading the tab,
// with changes unsaved asks first. `result` is what the action returned for this form.
export function SettingsForm({
  result,
  className,
  children,
}: {
  result: Result | undefined;
  className?: string;
  children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const saved = useRef("");
  const [dirty, setDirty] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const busy = useNavigation().state !== "idle";

  function check() {
    if (form.current) setDirty(snapshot(form.current) !== saved.current);
  }

  // A new answer from the action: saved, or why not.
  const [answered, setAnswered] = useState(result);
  if (result !== answered) {
    setAnswered(result);
    setFailed(result && !result.ok ? result.message : null);
    if (result?.ok) setDirty(false);
  }
  // What the form holds when it opens, and after each save, is what's saved.
  useEffect(() => {
    if (!form.current || (result && !result.ok)) return;
    saved.current = snapshot(form.current);
    if (result) toast(result.message);
  }, [result]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void chooseDialog("有未保存的修改，离开后将丢失。", [
      { value: "", label: "继续编辑", variant: "ghost" },
      { value: "leave", label: "放弃修改并离开", variant: "destructive" },
    ]).then((choice) => (choice === "leave" ? blocker.proceed() : blocker.reset()));
  }, [blocker]);

  // Closing or reloading the tab: browsers ask in their own words.
  useEffect(() => {
    if (!dirty) return undefined;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", ask);
    return () => removeEventListener("beforeunload", ask);
  }, [dirty]);

  return (
    <Form
      ref={form}
      method="post"
      className={className}
      onInput={() => {
        setFailed(null);
        check();
      }}
      onChange={check}
      // Fires before the fields go back, and Selects go back as they render again.
      onReset={() => setTimeout(check)}
    >
      {children}
      {(dirty || failed) && (
        <div className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 mt-6 flex items-center gap-2 rounded-2xl border bg-card py-2.5 pr-2.5 pl-4 shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-300">
          <p
            role={failed ? "alert" : "status"}
            className={failed ? "flex-1 text-sm text-destructive" : "flex-1 text-sm"}
          >
            {failed ?? "有未保存的修改"}
          </p>
          <Button type="reset" variant="ghost" disabled={busy}>
            撤销
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      )}
    </Form>
  );
}
