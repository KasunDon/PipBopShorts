import { useCallback, useEffect, useRef, useState } from 'react';

/** Marks an abort as "we gave up waiting" rather than a real failure — no scary error banner for either. */
const TIMEOUT_REASON = 'pipbop-timeout';

export interface AsyncActionOptions {
  /** Safety backstop so a hung request always recovers instead of spinning forever. Default 10 minutes. */
  timeoutMs?: number;
}

/**
 * Drives a single long-running async action (an LLM call, a PixVerse render)
 * with the feedback a slow network call needs: an elapsed-time readout so a
 * slow call doesn't read as a hung one, a cancel button, a safety timeout so
 * a truly stuck request always recovers, and error vs. cancel vs. timeout
 * kept distinct so the UI never shows a scary error for a user-initiated cancel.
 */
export function useAsyncAction(options: AsyncActionOptions = {}) {
  const [pending, setPending] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  const execute = useCallback(
    async <T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
      const controller = new AbortController();
      controllerRef.current = controller;
      setPending(true);
      setError(null);
      setElapsedSec(0);
      const start = Date.now();
      timerRef.current = setInterval(() => setElapsedSec(Math.floor((Date.now() - start) / 1000)), 1000);
      const safety = setTimeout(() => controller.abort(TIMEOUT_REASON), timeoutMs);

      try {
        return await fn(controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          if (controller.signal.reason === TIMEOUT_REASON) {
            const mins = Math.round(timeoutMs / 60000);
            setError(`This is taking longer than ${mins} minutes — the AI service may be slow or unreachable. You can retry.`);
          }
          // Otherwise the user cancelled deliberately — no error shown.
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        return undefined;
      } finally {
        clearTimeout(safety);
        if (timerRef.current) clearInterval(timerRef.current);
        controllerRef.current = null;
        setPending(false);
      }
    },
    [timeoutMs],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return { pending, elapsedSec, error, execute, cancel, dismissError };
}

export function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}
