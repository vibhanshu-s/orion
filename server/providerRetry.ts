/** Bounded retries for transient provider failures, shared by workflow and experts. */
export async function providerRetry<T>(operation: () => Promise<T>, options: {
  wait?: (ms: number) => Promise<void>;
  check?: () => void;
  onRetry?: (attempt: number, delayMs: number) => void;
  random?: () => number;
} = {}): Promise<T> {
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    options.check?.();
    try { return await operation(); }
    catch (error) {
      options.check?.();
      const message = error instanceof Error ? error.message : String(error);
      // A quota rejection must stop the panel; retrying every expert multiplies it.
      if (/\b429\b|resource_exhausted|quota/i.test(message)) throw error;
      if (attempt >= 2 || !/\b(408|499|5\d\d)\b|timeout|timed out|network|fetch failed|temporar/i.test(message)) throw error;
      const delayMs = 10_000 * 2 ** attempt + Math.floor((options.random ?? Math.random)() * 2000);
      options.onRetry?.(attempt + 1, delayMs);
      // Short waits keep cancellation and run deadlines responsive.
      for (let remaining = delayMs; remaining > 0; remaining -= 1000) {
        options.check?.();
        await wait(Math.min(remaining, 1000));
      }
    }
  }
}
