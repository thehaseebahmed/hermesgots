/**
 * The moments this device last rendered each session's thread — its **read mark** (GLOSSARY) — held
 * here on this device alone: never synced, never in the chat's fields (ADR 0046). The Code row's
 * blue dot shows while the session's last activity is newer than its mark (a session never opened
 * here has none, so it shows), and rendering the thread — in the pane or on its own page — writes
 * it back. One subscribe-able snapshot, so a list holding rows re-draws the moment a mark moves.
 */

import { useSyncExternalStore } from "react"

const KEY = "memento:read-marks"

const load = (): Record<string, number> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    return stored && typeof stored === "object" ? (stored as Record<string, number>) : {}
  } catch {
    // Storage blocked (private mode): the marks still work for this session's life.
    return {}
  }
}

let marks = load()
let snapshot = marks
const listeners = new Set<() => void>()

/** The moment this device last rendered the session's thread, if it ever has. */
export const readMark = (sessionId: string): number | undefined => marks[sessionId]

/** The thread has rendered on this device as of `at`: what clears its row's dot. Monotonic. */
export function markRead(sessionId: string, at = Date.now()) {
  if ((marks[sessionId] ?? 0) >= at) return
  marks = { ...marks, [sessionId]: at }
  snapshot = marks
  try {
    localStorage.setItem(KEY, JSON.stringify(marks))
  } catch {
    // Persisting failed; the in-memory marks still clear this session's dots.
  }
  for (const listen of listeners) listen()
}

const subscribe = (listen: () => void) => {
  listeners.add(listen)
  return () => listeners.delete(listen)
}

/** Re-renders whatever draws the dots when a mark moves. */
export const useReadMarks = (): Record<string, number> =>
  useSyncExternalStore(subscribe, () => snapshot)
