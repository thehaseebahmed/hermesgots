/**
 * A screen's own read, and the one control its failure earns.
 *
 * `attempt` keys the read's effect, so asking again is the same read rather than a second path to
 * the host. `landed` is the read's own word on how that attempt ended — the block arrived, or the
 * request was refused, never landed, or timed out — and it is the only thing that changes what
 * `retry` is: a reload that cleared the throw before its read landed would draw a page of controls
 * over numbers nobody has answered for. `release` is the effect's teardown, and it settles the same
 * promise the tap waits on, so a read abandoned mid-flight (the screen closed, the connection
 * changed) can never leave the control pending for good.
 */
import { useCallback, useEffect, useRef, useState } from "react"

export function useReadAttempt() {
  const [attempt, setAttempt] = useState(0)
  // Whether the attempt that last landed threw. Sticky until the next attempt lands: a reload is no
  // answer, and the notice stands with its control while one is out.
  const [threw, setThrew] = useState(false)
  // The tap waiting on this attempt's read, where one is out. The attempt it waits for rides with
  // it, so the effect of the attempt *before* it tearing down cannot answer for a read it never made.
  const pending = useRef<{ attempt: number; resolve: () => void } | null>(null)
  // The attempt the last reload asked for, which is the one `attempt` will be once React commits.
  const asked = useRef(0)

  /**
   * An attempt is over — it landed, or its effect went away — so whatever waits on it stops. Given
   * an attempt, only that attempt's tap is answered; given none, whatever is out is.
   */
  const release = useCallback((forAttempt?: number) => {
    const held = pending.current
    if (!held || (forAttempt !== undefined && held.attempt !== forAttempt)) return
    pending.current = null
    held.resolve()
  }, [])

  const landed = useCallback(
    (failed: boolean) => {
      release()
      setThrew(failed)
    },
    [release],
  )

  const reload = useCallback(() => {
    // A tap settles the tap before it rather than leaving it waiting on a read nobody made.
    release()
    asked.current += 1
    const next = asked.current
    return new Promise<void>((resolve) => {
      pending.current = { attempt: next, resolve }
      setAttempt(next)
    })
  }, [release])

  // The screen closing is a teardown no read of its own can report.
  useEffect(() => () => release(), [release])

  return { attempt, landed, release, retry: threw ? reload : undefined }
}
