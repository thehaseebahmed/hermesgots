import { useEffect, useRef, type DependencyList } from "react"

interface PollOptions {
  /** Off: nothing runs at all. */
  active?: boolean
  /** Runs once as soon as it starts (and again whenever `deps` change). */
  immediate?: boolean
  /** Runs again when the page comes back into view or back online. */
  onShow?: boolean
}

/**
 * Runs `read` every `ms` while the page is on screen and online (`false`: no timer), and again when
 * it comes back, so every screen that keeps something fresh pauses and resumes the same way. The
 * signal aborts when it stops or `deps` change, for a read that lands after.
 */
export function usePoll(
  read: (signal: AbortSignal) => void,
  ms: number | false,
  deps: DependencyList = [],
  { active = true, immediate = true, onShow = true }: PollOptions = {},
) {
  const latest = useRef(read)
  useEffect(() => {
    latest.current = read
  })
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const run = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return
      latest.current(controller.signal)
    }
    if (immediate) run()
    const timer = ms === false ? undefined : window.setInterval(run, ms)
    if (onShow) {
      document.addEventListener("visibilitychange", run)
      window.addEventListener("online", run)
    }
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", run)
      window.removeEventListener("online", run)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, immediate, onShow, ms, ...deps])
}
