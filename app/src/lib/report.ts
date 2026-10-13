/**
 * Notes a failure the caller handles by carrying on (the last answer stands, the next poll retries),
 * so it still shows in the console's verbose level instead of vanishing.
 */
export function noteFailure(what: string, error: unknown) {
  console.debug(`[memento] ${what} failed:`, error)
}

/** `noteFailure` as a promise's `.catch`, which then resolves to undefined. */
export const quietly =
  (what: string) =>
  (error: unknown): undefined => {
    noteFailure(what, error)
  }
