/**
 * The moments this device last rendered each session's thread — its **read mark** (GLOSSARY) — held
 * here on this device alone: never synced, never in the chat's fields (ADR 0046). The Code row's
 * blue dot shows while the session's last activity is newer than its mark, and only where there is
 * one: a session never opened here has no mark, so it shows nothing until the thread is rendered
 * once — in the pane or on its own page — which writes it back. One subscribe-able snapshot, so a
 * list holding rows re-draws the moment a mark moves.
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

const persist = (next: Record<string, number>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: the in-memory marks still hold for this session's life.
  }
}

/**
 * The thread has rendered on this device as of `at`: what its row's dot measures against, and what
 * has to exist before that dot can show at all. Monotonic — a mark never moves back — and the
 * oldest marks drop once the store is full, so a device that reads everything cannot grow it
 * without bound. An evicted mark reads as never opened: its row loses its dot until the thread is
 * opened once more.
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
  persist(next)
}

/** A deleted session takes its mark: `deleteConversation` drops it with the row. */
export function forgetRead(sessionId: string) {
  const current = marks.get()
  if (!(sessionId in current)) return
  const next = { ...current }
  delete next[sessionId]
  marks.set(next)
  persist(next)
}

/** Re-renders whatever draws the dots when a mark moves. */
export const useReadMarks = marks.use
