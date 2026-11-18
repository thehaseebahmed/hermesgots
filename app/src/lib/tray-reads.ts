/**
 * Mark as read, pressed in the Android tray, as the page reads it: the presses the phone queued
 * while the app wasn't running (`TrayReads.kt`, handed over by the `Tray` plugin), and the hold that
 * keeps a chat read through the activity its notice reported.
 *
 * A press alone can be overtaken: a catch-up floors a synced message's `createdAt` forward and the
 * record's `updatedAt` moves when it syncs, both after the press. So a press holds its chat read
 * through `through`, the host's moment of what the notice reported, and the chat is marked again by
 * its own clocks while its newest reply is one the host wrote no later than that. A reply written
 * after it is news, and keeps its dot. Import-free, so `scripts/test-tray-reads.mjs` runs it.
 */

/** One press: the chat, when it was pressed (this device's clock), and what it covered (the host's). */
export interface TrayRead {
  chat: string
  at: number
  through?: number
}

/** A chat held read through `through`, pressed at `press`, until `until`. */
export interface Hold {
  through: number
  press: number
  until: number
}

export type Holds = Record<string, Hold>

/** How long a hold waits for the chat's rows to catch up. */
export const HOLD_MS = 24 * 60 * 60 * 1000
/** The most chats held at once; the oldest presses go first. */
export const HOLD_KEEP = 100

const CHAT = /^[A-Za-z0-9._-]{1,256}$/
const moment = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0

/** The queue as the phone handed it over: the latest press per chat, and nothing that isn't one. */
export function latestReads(rows: unknown): TrayRead[] {
  if (!Array.isArray(rows)) return []
  const reads = new Map<string, TrayRead>()
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const { chat, at, through } = row as Record<string, unknown>
    if (typeof chat !== "string" || !CHAT.test(chat) || !moment(at)) continue
    const held = reads.get(chat)
    const covered = Math.max(held?.through ?? 0, moment(through) ? through : 0)
    reads.set(chat, {
      chat,
      at: Math.max(held?.at ?? 0, at),
      ...(covered ? { through: covered } : {}),
    })
  }
  return [...reads.values()]
}

/** Takes the phone's queue and hands each press to `read`; a queue it can't take moves nothing. */
export async function drainTrayReads(
  take: () => Promise<unknown>,
  read: (press: TrayRead) => void,
): Promise<void> {
  let rows: unknown
  try {
    rows = await take()
  } catch {
    return
  }
  for (const press of latestReads(rows)) read(press)
}

/** The holds with one press added: never moving back, a day-old one dropped, the newest kept. */
export function holdsWith(holds: Holds, read: TrayRead, now: number): Holds {
  const next: Holds = {}
  for (const [chat, hold] of Object.entries(holds)) if (hold.until > now) next[chat] = hold
  if (read.through) {
    const held = next[read.chat]
    next[read.chat] = {
      through: Math.max(held?.through ?? 0, read.through),
      press: Math.max(held?.press ?? 0, read.at),
      until: now + HOLD_MS,
    }
  }
  const entries = Object.entries(next)
  if (entries.length <= HOLD_KEEP) return next
  entries.sort((a, b) => b[1].press - a[1].press)
  return Object.fromEntries(entries.slice(0, HOLD_KEEP))
}

/** A held chat's clocks as its list draws them, and its newest reply. */
export interface HeldClocks {
  /** The list row's own clock: its newest reply's `createdAt`. */
  at?: number
  updatedAt?: number
  newest?: { hermesAt?: number; createdAt: number }
}

/**
 * What a hold does with a chat's clocks: mark it through them while its newest reply is one the
 * notice covered, or let go — once that reply is newer, which is news, or once the day is out. A
 * reply with no host clock yet is one this device wrote, judged against the press on its own clock.
 */
export function heldMark(
  hold: Hold,
  now: number,
  clocks: HeldClocks,
): { mark?: number } | "release" {
  if (hold.until <= now) return "release"
  const newest = clocks.newest
  if (newest) {
    const newer =
      newest.hermesAt != null ? newest.hermesAt > hold.through : newest.createdAt > hold.press
    if (newer) return "release"
  }
  const mark = Math.max(clocks.at ?? 0, clocks.updatedAt ?? 0)
  return mark > 0 ? { mark } : {}
}
