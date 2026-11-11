import { useCallback, type MouseEvent } from "react"
import { useNavigate } from "react-router"

/**
 * The `onClick` for a link to the thread the address already is: it stays an anchor — the sentence
 * reads the same and `aria-current` marks it here — but goes nowhere, since reopening would only
 * redraw the pane the thread is already in.
 */
export const stayHere = (current: boolean) =>
  current ? (event: MouseEvent<HTMLAnchorElement>) => event.preventDefault() : undefined

/**
 * The state a chat gives the entry it leaves a list in its place: the reader stepped back onto the
 * list, so it draws itself rather than opening the chat they have just come from.
 */
export const BACK_ON_LIST = { listed: true }

/**
 * History mirrors the screen hierarchy: a top-level screen (a chat, Code, Settings) is the first
 * entry, and each entry after it is a child of the one before. So back from a top-level screen
 * leaves the app, and back from a deeper one returns to its parent.
 */
export const depth = () => (window.history.state as { idx?: number } | null)?.idx ?? 0

export function useNav() {
  const navigate = useNavigate()

  /** Opens a top-level screen as the only entry, dropping whatever was opened before it. */
  const root = useCallback(
    (to: string) => {
      const steps = depth()
      if (!steps) return void navigate(to, { replace: true })
      window.addEventListener("popstate", () => navigate(to, { replace: true }), { once: true })
      window.history.go(-steps)
    },
    [navigate],
  )

  /**
   * Returns to the parent screen: back when it opened this one, else in this one's place. `state`
   * rides the entry that takes this one's place, so a screen that both opens and is stepped back
   * onto can tell the two apart.
   */
  const up = useCallback(
    (to: string, state?: Record<string, unknown>) => {
      if (depth()) window.history.back()
      else void navigate(to, { replace: true, state })
    },
    [navigate],
  )

  /**
   * The guard a screen gives the back button where the menu and a list both open it: a list pushes
   * it, so the press steps up to `to`; the menu opens it as the first entry, where nothing is behind
   * it, so the press is left to the app — which leaves, as back does from any top-level screen.
   */
  const step = useCallback(
    (to: string) => () => {
      if (!depth()) return false
      up(to)
      return true
    },
    [up],
  )

  return { root, up, step }
}
