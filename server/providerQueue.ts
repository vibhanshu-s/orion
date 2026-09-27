/** One in-flight provider operation with minimum spacing across all agent roles. */
export function createProviderQueue(intervalMs: number, clock = Date.now, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  let tail: Promise<unknown> = Promise.resolve();
  let nextStart = 0;
  return function schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      const delay = nextStart - clock();
      if (delay > 0) await wait(delay);
      nextStart = clock() + intervalMs;
      return operation();
    });
    tail = result.catch(() => {});
    return result;
  };
}
const spacing = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 15000);
export const scheduleProvider = createProviderQueue(Number.isFinite(spacing) ? Math.max(1000, spacing) : 15000);
