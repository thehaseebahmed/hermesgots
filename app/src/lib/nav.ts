import { useCallback, type MouseEvent } from "react"
import { useNavigate } from "react-router"

/**
 * Whether a press is the reader's own: the left button, with nothing held. A press meant for a new
 * tab or window belongs to the browser, so the app leaves it alone.
 */
export const plainPress = (event: MouseEvent<HTMLAnchorElement>) =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey

/**
 * The `onClick` for a link that opens a top-level screen: the plain press opens it as the app's only
 * entry, and a press meant for a new tab or window — a modifier held, or a button other than the
 * left — is left to the link the browser already has. Private, since a top-level screen is a place:
 * a conversation is pushed over its list and never rooted in the list's place.
 */
const opensAsRoot = (open: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
  if (!plainPress(event)) return
  event.preventDefault()
  open()
}

/**
 * A row's own press where it also opens as the app's one entry: what the row does first, then
 * `opensAsRoot`. The sidebar's rows all do both, so the order lives here rather than in each of them.
 */
export const pressOpeningRoot =
  (
    root: (to: string) => void,
    to: string,
    first?: (event: MouseEvent<HTMLAnchorElement>) => void,
  ) =>
  (event: MouseEvent<HTMLAnchorElement>) => {
    first?.(event)
    opensAsRoot(() => root(to))(event)
  }

/**
 * History mirrors the screen hierarchy: a top-level screen (a chat, Code, Settings) is the first
 * entry, and each entry after it is a child of the one before. So back from a top-level screen
 * leaves the app, and back from a deeper one returns to its parent.
 */
export const depth = () => (window.history.state as { idx?: number } | null)?.idx ?? 0

export function useNav() {
  const navigate = useNavigate()

  /**
   * Opens a top-level screen as the only entry, dropping whatever was opened before it. `state` rides
   * the entry the screen takes, so a screen that names what it belongs to still can.
   */
  const root = useCallback(
    (to: string, state?: Record<string, unknown>) => {
      const steps = depth()
      if (!steps) return void navigate(to, { replace: true, state })
      window.addEventListener("popstate", () => navigate(to, { replace: true, state }), {
        once: true,
      })
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
   * The guard a screen gives the back button where the menu and a list both open it: whatever
   * opened it stands behind it, so the press steps back to that; the menu opens it as the first
   * entry, where nothing is behind it, so the press is left to the app — which leaves, as back does
   * from any top-level screen.
   */
  const back = useCallback(
    () => () => {
      if (!depth()) return false
      window.history.back()
      return true
    },
    [],
  )

  return { root, up, back }
}