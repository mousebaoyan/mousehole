import { useEffect, useEffectEvent, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "~/components/ui/toast";

// What an action answers when it saves one value: the value as saved, or why it couldn't be.
export type Saved<T> = { ok: true; saved: T } | { ok: false; message: string };

// A value the reader changes through a page action: it shows as submitted at once and then as
// the action saved it. A failure puts back the value saved before and says why. `field` is the
// form field that carries the value; `parse` reads it back; `told`, when given, is what to say
// once a value is saved.
export function useSavedValue<T>(
  initial: T,
  action: string,
  field: string,
  parse: (raw: string) => T,
  told?: (saved: T) => string,
) {
  const fetcher = useFetcher<Saved<T>>();
  const [saved, setSaved] = useState({ value: initial, data: fetcher.data });
  if (fetcher.data !== saved.data) {
    setSaved({ value: fetcher.data?.ok ? fetcher.data.saved : saved.value, data: fetcher.data });
  }
  const answered = useEffectEvent((data: Saved<T>) => {
    if (!data.ok) toast(data.message);
    else if (told) toast(told(data.saved));
  });
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) answered(fetcher.data);
  }, [fetcher.state, fetcher.data]);

  const pending = fetcher.formData?.get(field);
  return {
    value: typeof pending === "string" ? parse(pending) : saved.value,
    save: (form: Record<string, string | number>) => {
      void fetcher.submit(form, { method: "post", action, defaultShouldRevalidate: false });
    },
  };
}
