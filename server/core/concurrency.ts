/** Per-season requests in flight at once: a library with hundreds of started shows took a minute one at a time. */
export const SEASON_CONCURRENCY = 6;

/** Runs `fn` over `items` with at most `limit` running at once. */
export async function eachLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
