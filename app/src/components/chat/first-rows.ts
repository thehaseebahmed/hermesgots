import { startTransition, useEffect, useState } from "react"

// The rows a chat draws in the commit it opens with: the end the reader lands on. Every row's
// markdown is parsed as it mounts, so drawing a long transcript whole kept a switch blank for
// hundreds of milliseconds on a phone; the rows above follow in a transition.
export const FIRST_ROWS = 8
// The least height a row and its gap take: a chat with more rows than fit the window this way
// overflows it once drawn whole, so its last row ends where the opening frame put it.
const LEAST_ROW = 44
const REST_AFTER_MS = 250

/**
 * The rows of a chat's flow to draw now. The chat this pane has drawn whole (`key`) is drawn whole;
 * a long one opens on its last rows and draws the rest in a transition, and one short enough to be
 * sure of not overflowing the window is cheap to draw at once, so it is whole from its first frame,
 * with no second commit to disturb its placing. `ready` is false until the chat has answered.
 */
export function useFirstRows<T>(
  key: string,
  flow: T[],
  ready: boolean,
): { drawn: T[]; cut: boolean } {
  const [whole, setWhole] = useState<string>()
  const long = flow.length > Math.max(FIRST_ROWS, window.innerHeight / LEAST_ROW)
  if (ready && whole !== key && !long) setWhole(key)
  const cut = ready && whole !== key && long
  useEffect(() => {
    if (!cut) return
    // A beat later, so a reader moving straight on to another chat never waits behind these rows.
    const timer = window.setTimeout(() => startTransition(() => setWhole(key)), REST_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [cut, key])
  return { drawn: cut ? flow.slice(-FIRST_ROWS) : flow, cut }
}
