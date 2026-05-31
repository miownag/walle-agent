/**
 * Small helpers for AbortSignal composition.
 */

/**
 * Return an AbortSignal that aborts as soon as any of `signals` aborts.
 *
 * Prefers `AbortSignal.any` (Node 20+); falls back to an event-listener
 * polyfill otherwise. `undefined` entries are ignored.
 */
export function mergeAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const real = signals.filter((s): s is AbortSignal => !!s);
  if (real.length === 0) return new AbortController().signal;
  if (real.length === 1) return real[0];

  // Native path (Node 20+).
  const Any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof Any === "function") {
    return Any.call(AbortSignal, real);
  }

  // Fallback: plumb manually.
  const controller = new AbortController();
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const s of real) {
    if (s.aborted) {
      abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => abort(s.reason), { once: true });
  }
  return controller.signal;
}
