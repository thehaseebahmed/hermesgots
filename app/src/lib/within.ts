/**
 * A promise given at most `ms` to resolve: what it answers, or undefined when the wait is up. A
 * flow's ending is bounded by this rather than by the host answering, so a wedged host can't hold
 * it (a take's ending, ADR 0038; a chat-list pass, which reports what answered).
 */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: number | undefined
  const wait = new Promise<undefined>((done) => {
    timer = window.setTimeout(done, ms)
  })
  return Promise.race([promise.catch(() => undefined), wait]).finally(() =>
    window.clearTimeout(timer),
  )
}
