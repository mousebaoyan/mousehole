import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { cn } from "cn";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

// A native <dialog>: showModal() brings the backdrop, Esc and focus handling. Visible overflow
// lets a Select's list reach past the edge of a small dialog.
export function Dialog({ className, ...props }: ComponentProps<"dialog">) {
  return (
    <dialog
      className={cn(
        "m-auto w-[min(24rem,calc(100%-2rem))] overflow-visible rounded-2xl border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/30",
        className,
      )}
      {...props}
    />
  );
}

// Questions asked in place of window.confirm and window.prompt. They are kept outside React so
// a handler can await one, even from a menu that closes as it asks; <DialogHost /> in the root
// shows them.
type Question = {
  text: string;
  action: string;
  // Present when the answer is text: what the box says while empty.
  placeholder?: string;
  answer: (reply: string | null) => void;
};

let asking: Question | null = null;
const listeners = new Set<() => void>();

function set(next: Question | null) {
  asking = next;
  for (const listener of listeners) listener();
}

function ask(question: Omit<Question, "answer">) {
  return new Promise<string | null>((resolve) =>
    set({
      ...question,
      answer: (reply) => {
        set(null);
        resolve(reply);
      },
    }),
  );
}

// For what can't be undone; `action` is the button that goes ahead, such as 删除.
export async function confirmDialog(text: string, action: string) {
  return (await ask({ text, action })) !== null;
}

// Null when cancelled; the text may be empty.
export function promptDialog(text: string, placeholder: string, action: string) {
  return ask({ text, action, placeholder });
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
  const text = question.placeholder !== undefined;
  return (
    <Dialog
      ref={ref}
      // returnValue is the button that closed it; Esc leaves it empty.
      onClose={(e) =>
        question.answer(e.currentTarget.returnValue === "ok" ? (reply.current?.value ?? "") : null)
      }
    >
      <form method="dialog">
        <p className="text-sm">{question.text}</p>
        {text && (
          <Textarea
            ref={reply}
            aria-label={question.text}
            placeholder={question.placeholder}
            maxLength={200}
            className="mt-3 min-h-20"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button value="" variant="ghost">
            取消
          </Button>
          <Button value="ok" variant={text ? "default" : "destructive"}>
            {question.action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// A submit button's onClick: asks first, then sends the form as if the button had been clicked.
export function confirmSubmit(text: string, action: string) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const button = e.currentTarget;
    void confirmDialog(text, action).then((ok) => ok && button.form?.requestSubmit(button));
  };
}
