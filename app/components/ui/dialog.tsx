import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { cn } from "~/cn";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

// A native <dialog>: showModal() brings the backdrop, Esc and focus handling. Visible overflow
// lets a Select's list reach past the edge of a small dialog.
export function Dialog({ className, ...props }: ComponentProps<"dialog">) {
  return (
    <dialog
      className={cn(
        "m-auto w-[min(24rem,calc(100%-2rem))] overflow-visible rounded-2xl border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/30 open:animate-in open:fade-in open:zoom-in-95 backdrop:animate-in backdrop:fade-in",
        className,
      )}
      {...props}
    />
  );
}

// Questions asked in place of window.confirm and window.prompt. They are kept outside React so
// a handler can await one, even from a menu that closes as it asks; <DialogHost /> in the root
// shows them.
type Choice = { value: string; label: string; variant: "default" | "destructive" | "ghost" };

type Question = {
  text: string;
  // In the order shown; the last is the one that goes ahead.
  choices: Choice[];
  // Present when the answer is text: what the box says while empty.
  placeholder?: string;
  required?: boolean;
  // The value of the button chosen, null for one with an empty value or Esc; and the text.
  answer: (value: string | null, text: string) => void;
};

let asking: Question | null = null;
const listeners = new Set<() => void>();

function set(next: Question | null) {
  asking = next;
  for (const listener of listeners) listener();
}

function ask(question: Omit<Question, "answer">) {
  return new Promise<{ value: string | null; text: string }>((resolve) =>
    set({
      ...question,
      answer: (value, text) => {
        set(null);
        resolve({ value, text });
      },
    }),
  );
}

const CANCEL: Choice = { value: "", label: "取消", variant: "ghost" };

// For what can't be undone; `action` is the button that goes ahead, such as 删除.
export async function confirmDialog(text: string, action: string) {
  const { value } = await ask({
    text,
    choices: [CANCEL, { value: "ok", label: action, variant: "destructive" }],
  });
  return value !== null;
}

// For taking something of someone's away with a reason. Null when cancelled; the text may be
// empty unless required.
export async function promptDialog(
  text: string,
  placeholder: string,
  action: string,
  required = false,
) {
  const answer = await ask({
    text,
    placeholder,
    required,
    choices: [CANCEL, { value: "ok", label: action, variant: "destructive" }],
  });
  return answer.value === null ? null : answer.text;
}

// One of several ways on: the value of the button chosen, or null for one with an empty value
// and for Esc.
export async function chooseDialog(text: string, choices: Choice[]) {
  return (await ask({ text, choices })).value;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function DialogHost() {
  const question = useSyncExternalStore(
    subscribe,
    () => asking,
    () => null,
  );
  return question && <Asking question={question} />;
}

function Asking({ question }: { question: Question }) {
  const ref = useRef<HTMLDialogElement>(null);
  const reply = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <Dialog
      ref={ref}
      // returnValue is the value of the button that closed it; Esc leaves it empty.
      onClose={(e) =>
        question.answer(e.currentTarget.returnValue || null, reply.current?.value ?? "")
      }
    >
      <form method="dialog">
        <p className="text-sm">{question.text}</p>
        {question.placeholder !== undefined && (
          <Textarea
            ref={reply}
            aria-label={question.text}
            placeholder={question.placeholder}
            required={question.required}
            maxLength={200}
            className="mt-3 min-h-20"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          {question.choices.map((c) => (
            <Button key={c.label} value={c.value} variant={c.variant} formNoValidate={!c.value}>
              {c.label}
            </Button>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

// A submit button's onClick: asks first, then clicks the button again, a click that doesn't come
// from the user and so goes through. Safari 15 has no requestSubmit() to send the form directly.
export function confirmSubmit(text: string, action: string) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    const button = e.currentTarget;
    void confirmDialog(text, action).then((ok) => ok && button.click());
  };
}
