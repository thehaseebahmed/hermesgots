import { useEffect, useState } from "react"
import { matchPath, useLocation, useNavigate } from "react-router"

import { db } from "@/lib/db"

/** The chat or session open when the app was last left, and when; a per-device convenience. */
const LAST_KEY = "memento:last-chat"
/** Past this, a launch starts a new chat rather than picking up an old thread. */
const REOPEN_WITHIN_MS = 60 * 60 * 1000

function read() {
  try {
    const last: unknown = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null")
    if (!last || typeof last !== "object") return null
    const { id, at } = last as { id?: unknown; at?: unknown }
    if (typeof id !== "string" || typeof at !== "number") return null
    return Date.now() - at <= REOPEN_WITHIN_MS ? id : null
  } catch {
    return null
  }
}

function write(id: string | undefined) {
  try {
    if (id) localStorage.setItem(LAST_KEY, JSON.stringify({ id, at: Date.now() }))
    else localStorage.removeItem(LAST_KEY)
  } catch {
    // Storage can be blocked; launching on a new chat is the fallback.
  }
}

// Read before anything records the screen the app opens on, and used once.
let launched = window.location.pathname === "/" ? read() : null
let skipped = false

/** A share that opened the app goes to the share screen instead. */
export function skipLaunchRestore() {
  skipped = true
}

/**
 * Reopens the chat or session that was open when the app was last left, within the hour, when it
 * launches on a new chat. Leaving from any other screen launches on a new chat as before. Until it
 * knows, nothing renders, so a new chat doesn't flash first.
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
      .then((chat) => chat && !skipped && navigate(`/c/${chat.id}`, { replace: true }))
      .catch(() => {})
      .finally(() => setReady(true))
  }, [navigate])
  return ready
}

/**
 * Remembers the open chat or session, and forgets it on any other screen. The time moves on
 * whenever the app is hidden, so the hour counts from when it was left, not opened.
 */
export function useRecordLastChat() {
  const { pathname } = useLocation()
  useEffect(() => {
    const id = matchPath("/c/:id", pathname)?.params.id
    write(id)
    if (!id) return
    const leave = () => document.visibilityState === "hidden" && write(id)
    document.addEventListener("visibilitychange", leave)
    return () => document.removeEventListener("visibilitychange", leave)
  }, [pathname])
}
