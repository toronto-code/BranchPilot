// Node timers clamp larger delays to one millisecond instead of waiting longer.
export const MAX_TIMEOUT_MS = 2_147_483_647;

const deadlineChecks = new WeakMap<AbortSignal, () => void>();

/** Preserve synchronous deadline checks when cancellation scopes are nested.
 * Native AbortSignal.any only notices deadlines after a timer actually runs. */
export function combineSignals(signals: AbortSignal[]): AbortSignal {
  const signal = AbortSignal.any(signals);
  deadlineChecks.set(signal, () => { for (const parent of signals) deadlineChecks.get(parent)?.(); });
  return signal;
}

/** Check absolute deadlines at a dispatch boundary, even before timers get
 * their first turn after host sleep or synchronous preparation. */
export function checkCancellation(signal?: AbortSignal): void {
  if (!signal) return;
  deadlineChecks.get(signal)?.();
  signal.throwIfAborted();
}

/** Timers can pause during system sleep. Recheck the absolute wall deadline
 * frequently so the remaining awake-time delay is never spent after resume.
 * check() also guards dispatch/readback boundaries before the next timer tick.
 */
export function wallDeadline(deadline: number, reason: Error) {
  if (!Number.isFinite(deadline)) throw Error('Invalid wall deadline');
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const check = () => {
    if (!controller.signal.aborted && Date.now() >= deadline) {
      controller.abort(reason);
      if (timer) clearInterval(timer);
    }
    return controller.signal;
  };
  deadlineChecks.set(controller.signal, check);
  check();
  if (!controller.signal.aborted) timer = setInterval(check, Math.max(1, Math.min(100, deadline - Date.now())));
  return { signal: controller.signal, check, dispose: () => { if (timer) clearInterval(timer); } };
}
