import { useCallback, type MouseEvent } from "react"
import { useNavigate } from "react-router"

/**
 * The state a room's screen and a routine's run give the entry they leave a bot's list in: the reader
 * stepped back onto the list, so it draws itself rather than landing in the chat behind it.
 */
export const BACK_ON_LIST = { listed: true }

/**
 * The `onClick` for a link that opens a top-level screen: the plain press opens it as the app's only
 * entry, and a press meant for a new tab or window — a modifier held, or a button other than the
 * left — is left to the link the browser already has.
 */
export const opensAsRoot = (open: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.defaultPrevented || event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  open()
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
   * Steps back onto a list this screen's row stands in: `up`'s move with the marker a list reads as
   * "the reader stepped back here". A list left without it reads the entry as a fresh arrival and
   * lands the reader in the chat behind it, so the move carries the marker rather than each caller.
   */
  const backToList = useCallback(
    (to: string) => up(to, BACK_ON_LIST),
    [up],
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

  return { root, up, backToList, back }
}
