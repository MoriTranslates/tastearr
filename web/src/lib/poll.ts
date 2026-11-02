/**
 * Calls `step` after `firstDelayMs`, then again every `delayMs` for as long as `keepGoing` says the last result isn't
 * final. Returns a function that stops everything: no further `step` call, and a result still in flight is dropped
 * without `onResult`, so a screen that was left can't be updated afterwards.
 */
export function pollUntil<T>(opts: {
  step: () => Promise<T>;
  keepGoing: (result: T) => boolean;
  onResult: (result: T) => void;
  onError: (error: unknown) => void;
  delayMs: number;
  firstDelayMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      const result = await opts.step();
      if (stopped) return;
      opts.onResult(result);
      if (opts.keepGoing(result)) timer = setTimeout(() => void tick(), opts.delayMs);
    } catch (e) {
      if (!stopped) opts.onError(e);
    }
  };
  timer = setTimeout(() => void tick(), opts.firstDelayMs ?? opts.delayMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
