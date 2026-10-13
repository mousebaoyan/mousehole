import { log } from "./log.ts";

// Jobs that run every so often inside this one process. A failed run is logged and the next one
// tries again.
export function every(ms: number, name: string, job: () => Promise<unknown>) {
  setInterval(() => {
    job().catch((error: unknown) => log("error", `${name} failed`, { error }));
  }, ms).unref();
}
