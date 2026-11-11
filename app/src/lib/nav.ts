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
 * The state a room's screen and a routine's run give the entry they leave a bot's list in: the reader
 * stepped back onto the list, so it draws itself rather than landing in the chat behind it.
 */
export const BACK_ON_LIST = { listed: true }

export const OPENED_CHAT = (id: string) => ({ open: id })

export const openedChat = (state: unknown) => (state as { open?: string } | null)?.open

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
