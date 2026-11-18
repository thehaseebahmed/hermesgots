/**
 * Mark as read pressed in the Android tray, applied on this device: the queue the phone kept while
 * the app wasn't running is taken and each press marks its chat (`readThrough`), and the chats a
 * press holds read are followed while their rows catch up (`followHeldReads`), so a reply that synced
 * after the press loses its dot and one the host wrote after the notice keeps it (`tray-reads.ts`).
 */
import { liveQuery, type Subscription } from "dexie"

import { db, isReply, newestMessage } from "@/lib/db"
import { quietly } from "@/lib/report"
import { markRead } from "@/lib/read-marks"
import { createStore } from "@/lib/store"
import {
  drainTrayReads,
  heldMark,
  holdsWith,
  type HeldClocks,
  type Hold,
  type Holds,
  type TrayRead,
} from "@/lib/tray-reads"

const isMoment = (at: unknown): at is number => typeof at === "number" && at > 0

const HELD_KEY = "gots:read-through"

const loadHeld = (): Holds => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HELD_KEY) ?? "{}")
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {}
    const holds: Holds = {}
    for (const [chat, hold] of Object.entries(stored as Record<string, Partial<Hold>>)) {
      if (isMoment(hold?.through) && isMoment(hold?.press) && isMoment(hold?.until))
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

const heldReads = held.get
const onHeldReads = held.subscribe

/** A hold lets go: something in the chat is newer than what the press covered, or its day is out. */
export function releaseHeld(chat: string) {
  const current = held.get()
  if (!(chat in current)) return
  const next = { ...current }
  delete next[chat]
  persistHeld(next)
}

/** Takes the phone's queued presses and marks each chat they name. */
export function takeTrayReads(take: () => Promise<unknown>): Promise<void> {
  return drainTrayReads(take, (read) => readThrough(read))
}

async function clocksOf(chats: readonly string[]): Promise<Record<string, HeldClocks>> {
  const clocks: Record<string, HeldClocks> = {}
  for (const chat of chats) {
    const [record, reply] = await Promise.all([
      db.conversations.get(chat),
      newestMessage(chat, isReply),
    ])
    clocks[chat] = {
      ...(record ? { updatedAt: record.updatedAt } : {}),
      ...(reply
        ? {
            at: reply.createdAt,
            newest: { hermesAt: reply.hermesAt, createdAt: reply.createdAt },
          }
        : {}),
    }
  }
  return clocks
}

let following: (() => void) | undefined

/**
 * Marks every held chat again each time its rows move, while the hold stands. One follower for the
 * page; calling it again keeps the one already running. Answers the way to stop it.
 */
export function followHeldReads(): () => void {
  if (following) return following
  let subscription: Subscription | undefined
  const watch = () => {
    subscription?.unsubscribe()
    subscription = undefined
    const chats = Object.keys(heldReads())
    if (!chats.length) return
    subscription = liveQuery(() => clocksOf(chats)).subscribe({
      next: (clocks) => {
        const holds = heldReads()
        const now = Date.now()
        for (const chat of chats) {
          const hold = holds[chat]
          if (!hold) continue
          const answer = heldMark(hold, now, clocks[chat] ?? {})
          if (answer === "release") releaseHeld(chat)
          else if (answer.mark) markRead(chat, answer.mark)
        }
      },
      error: quietly("following a tray's held reads"),
    })
  }
  let last = Object.keys(heldReads()).join("\n")
  const unsubscribe = onHeldReads(() => {
    const now = Object.keys(heldReads()).join("\n")
    if (now === last) return
    last = now
    watch()
  })
  watch()
  following = () => {
    unsubscribe()
    subscription?.unsubscribe()
    following = undefined
  }
  return following
}
