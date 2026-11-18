/**
 * Mark as read pressed in the Android tray, applied on this device: the queue the phone kept while
 * the app wasn't running is taken and each press marks its chat (`readThrough`), and the chats a
 * press holds read are followed while their rows catch up (`followHeldReads`), so a reply that synced
 * after the press loses its dot and one the host wrote after the notice keeps it (`tray-reads.ts`).
 */
import { liveQuery, type Subscription } from "dexie"

import { db, isReply, newestMessage } from "@/lib/db"
import { heldReads, markRead, onHeldReads, readThrough, releaseHeld } from "@/lib/read-marks"
import { drainTrayReads, heldMark, type HeldClocks } from "@/lib/tray-reads"

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
      ...(reply ? { at: reply.createdAt } : {}),
      ...(record ? { updatedAt: record.updatedAt } : {}),
      ...(reply ? { newest: { hermesAt: reply.hermesAt, createdAt: reply.createdAt } } : {}),
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
      error: () => {},
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
