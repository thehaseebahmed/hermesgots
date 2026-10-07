import { useEffect, useState } from "react"
import { matchPath, useLocation, useNavigate } from "react-router"

import { db } from "@/lib/db"

/** The chat or session open when the app was last left; a per-device convenience. */
const LAST_KEY = "memento:last-chat"

function read() {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

// Read before anything records the screen the app opens on, and used once.
let launched = window.location.pathname === "/" ? read() : null

/**
 * Reopens the chat or session that was open when the app was last left, when it launches on a new
 * chat. Leaving from any other screen launches on a new chat as before. Until it knows, nothing
 * renders, so a new chat doesn't flash first.
 */
export function useLaunchRestore() {
  const navigate = useNavigate()
  const [ready, setReady] = useState(!launched)
  useEffect(() => {
    if (!launched) return
    const id = launched
    launched = null
    void db.conversations
      .get(id)
      .then((chat) => chat && navigate(`/c/${chat.id}`, { replace: true }))
      .catch(() => {})
      .finally(() => setReady(true))
  }, [navigate])
  return ready
}

/** Remembers the open chat or session, and forgets it on any other screen. */
export function useRecordLastChat() {
  const { pathname } = useLocation()
  useEffect(() => {
    const id = matchPath("/c/:id", pathname)?.params.id
    try {
      if (id) localStorage.setItem(LAST_KEY, id)
      else localStorage.removeItem(LAST_KEY)
    } catch {
      // Storage can be blocked; launching on a new chat is the fallback.
    }
  }, [pathname])
}
