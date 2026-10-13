/**
 * Tracks when something was last tried, so a caller can back off from asking again too soon (a
 * plugin route an older bot lacks, a stream that isn't supported). One map per call site: make a
 * tracker, then `cooling(key)` before trying and `cool(key)` when the try fails or isn't worth
 * repeating yet.
 */
export function cooldown(ms: number) {
  const since = new Map<string, number>()
  return {
    /** Whether `key` was marked within the last `ms`, so it's too soon to try again. */
    cooling: (key: string) => Date.now() - (since.get(key) ?? -Infinity) < ms,
    /** Marks `key` as tried now. */
    cool: (key: string) => void since.set(key, Date.now()),
    /** Clears `key`, so the next check isn't cooling. */
    clear: (key: string) => void since.delete(key),
  }
}
