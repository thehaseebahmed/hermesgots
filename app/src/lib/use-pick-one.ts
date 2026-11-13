/**
 * The trigger a pick's opener calls: it decides from the list the screen shows at the tap, applies a
 * lone option once, and wears `busy` while that write is out.
 *
 * The list is held in a ref that follows every commit, so the decision is taken against what the
 * screen shows at the tap rather than against a closure from an earlier one. Nothing decides from
 * the list outside a tap — no effect, watcher or timer — which is what makes a list that settles
 * late harmless: it has no path to an apply, and only draws the rows of a sheet already open.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { pickStep, type PickRead } from "@/lib/pick-one"

export function usePickOne<T>({
  read,
  same,
  apply,
}: {
  read: PickRead<T>
  /** Whether an option is the value already in force, so a tap on it does nothing at all. */
  same?: (option: T) => boolean
  /** The write a row's tap makes: the same call the surface's own rows make. */
  apply: (option: T) => void | Promise<void>
}) {
  const latest = useRef({ read, same, apply })
  // Every render, after it commits: a tap always decides against what the screen has just shown.
  useEffect(() => {
    latest.current = { read, same, apply }
  })
  const [busy, setBusy] = useState(false)
  // Marked before the write starts and released when it lands: a second tap writes nothing, and a
  // write the host refused can be tried again.
  const held = useRef(false)

  const tap = useCallback((open: () => void) => {
    const { read, same, apply } = latest.current
    const step = pickStep(read, same)
    if (step.act === "open") return open()
    if (step.act === "quiet" || held.current) return
    held.current = true
    setBusy(true)
    const release = () => {
      held.current = false
      setBusy(false)
    }
    let write: void | Promise<void>
    try {
      write = apply(step.option)
    } catch (error) {
      release()
      throw error
    }
    // The surface's own handler says a refusal where it draws refusals; this only lets the guard go.
    void Promise.resolve(write).then(release, release)
  }, [])

  return { tap, busy }
}
