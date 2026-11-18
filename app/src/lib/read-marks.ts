/**
 * The moments this device last rendered each session's thread — its **read mark** (GLOSSARY) — held
 * here on this device alone: never synced, never in the chat's fields (ADR 0046). What a mark means
 * to the Code row's dot is `isUnread` (session-work.ts, ADR 0056). One subscribe-able snapshot, so
 * a list holding rows re-draws the moment a mark moves.
 */

import { createStore } from "@/lib/store"
import { holdsWith, type Hold, type Holds, type TrayRead } from "@/lib/tray-reads"

const KEY = "gots:read-marks"
/** The store only ever grows: the oldest marks drop past this many. */
const KEEP = 500

const isMark = (at: unknown): at is number => typeof at === "number" && at > 0

const load = (): Record<string, number> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {}
    const marks: Record<string, number> = {}
    for (const [id, at] of Object.entries(stored)) {
      if (isMark(at)) marks[id] = at
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

/** This device's mark for one session, for a caller that wants the moment itself. */
export const readMark = (sessionId: string): number | undefined => marks.get()[sessionId]

/** Re-renders whatever draws the dots when a mark moves. */
export const useReadMarks = marks.use

const HELD_KEY = "gots:read-through"

const loadHeld = (): Holds => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HELD_KEY) ?? "{}")
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {}
    const holds: Holds = {}
    for (const [chat, hold] of Object.entries(stored as Record<string, Partial<Hold>>)) {
      if (isMark(hold?.through) && isMark(hold?.press) && isMark(hold?.until))
        holds[chat] = { through: hold.through, press: hold.press, until: hold.until }
    }
    return holds
  } catch {
    return {}
  }
}

const held = createStore<Holds>(loadHeld())

const persistHeld = (next: Holds) => {
  held.set(next)
  try {
    localStorage.setItem(HELD_KEY, JSON.stringify(next))
  } catch {
    // Blocked storage: the holds still hold for this session's life.
  }
}

/**
 * A Mark as read pressed in the tray (`tray-reads.ts`): the chat is marked read at once, through the
 * later of the press and the activity its notice reported, and held read through that activity until
 * its rows catch up — a clock a later sync writes can be newer than the press. Device-local, like
 * every mark, and bounded: a hold lasts a day.
 */
export function readThrough(read: TrayRead, now = Date.now()) {
  markRead(read.chat, Math.max(read.at, read.through ?? 0))
  if (read.through) persistHeld(holdsWith(held.get(), read, now))
}

/** The chats held read through a tray's press, for the one follower that marks them. */
export const heldReads = held.get
export const onHeldReads = held.subscribe

/** A hold lets go: the chat's newest reply is newer than what the press covered, or its day is out. */
export function releaseHeld(chat: string) {
  const current = held.get()
  if (!(chat in current)) return
  const next = { ...current }
  delete next[chat]
  persistHeld(next)
}
