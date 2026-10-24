/**
 * The moments this device last rendered each session's thread — its **read mark** (GLOSSARY) — held
 * here on this device alone: never synced, never in the chat's fields (ADR 0046). The Code row's
 * blue dot shows while the session's last activity is newer than its mark (a session never opened
 * here has none, so it shows), and rendering the thread — in the pane or on its own page — writes
 * it back. One subscribe-able snapshot, so a list holding rows re-draws the moment a mark moves.
 */

import { createStore } from "@/lib/store"

const KEY = "memento:read-marks"
/** The store only ever grows: the oldest marks drop past this many. */
const KEEP = 500

const load = (): Record<string, number> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {}
    const marks: Record<string, number> = {}
    for (const [id, at] of Object.entries(stored)) {
      if (typeof at === "number") marks[id] = at
    }
    return marks
  } catch {
    // Storage blocked (private mode): the marks still work for this session's life.
    return {}
  }
}

const marks = createStore<Record<string, number>>(load())

/**
 * The thread has rendered on this device as of `at`: what clears its row's dot. Monotonic — a
 * mark never moves back — and the oldest marks drop once the store is full, so a device that
 * reads everything cannot grow it without bound.
 */
export function markRead(sessionId: string, at = Date.now()) {
  const current = marks.get()
  if ((current[sessionId] ?? 0) >= at) return
  let next = { ...current, [sessionId]: at }
  const entries = Object.entries(next)
  if (entries.length > KEEP) {
    entries.sort((a, b) => b[1] - a[1])
    next = Object.fromEntries(entries.slice(0, KEEP))
  }
  marks.set(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Persisting failed; the in-memory marks still clear this session's dots.
  }
}

/** Re-renders whatever draws the dots when a mark moves. */
export const useReadMarks = marks.use
