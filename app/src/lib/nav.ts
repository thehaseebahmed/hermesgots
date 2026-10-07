import { useCallback } from "react"
import { useNavigate } from "react-router"

/**
 * History mirrors the screen hierarchy: a top-level screen (a chat, Code, Routines, Settings) is
 * the first entry, and each entry after it is a child of the one before. So back from a top-level
 * screen leaves the app, and back from a deeper one returns to its parent.
 */
const depth = () => (window.history.state as { idx?: number } | null)?.idx ?? 0

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

  /** Returns to the parent screen: back when it opened this one, else in this one's place. */
  const up = useCallback(
    (to: string) => {
      if (depth()) window.history.back()
      else void navigate(to, { replace: true })
    },
    [navigate],
  )

  return { root, up }
}
