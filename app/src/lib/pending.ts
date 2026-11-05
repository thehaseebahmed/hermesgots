/**
 * The queue Hermes itself keeps for a session, as the chat draws it: the inputs still in line, and
 * the turn a restart lost out from under them.
 *
 * Hermes admits every prompt to a session's own FIFO rather than refusing it while a turn runs, and
 * a turn whose owner restarted mid-execution is fenced `unknown` — nothing behind it runs until it
 * is acknowledged (the TUI's `/discard`). So a chat can sit holding a message that will never start,
 * which is what this card says out loud, with the one control that clears it.
 *
 * Import-free but for the one line rule (`words.ts`), so `scripts/test-pending.mjs` runs it as a
 * pure rule.
 */

import { oneLine } from "./words.ts"

/** One input the host holds for a session: its words, and whether it was the turn that was lost. */
export type PendingInput = {
  id: string
  text: string
  /** `queued` waits in line; `unknown` is a turn the host can't say finished. */
  status: "queued" | "unknown"
}

export type PendingQueue = {
  items: PendingInput[]
  /** The row that holds the queue: the first lost turn, else null. */
  lost: string | null
  paused: boolean
}

export const EMPTY_QUEUE: PendingQueue = { items: [], lost: null, paused: false }

/** A row of the card: what the host holds, and the one word that says why it's held. */
export type PendingRow = {
  id: string
  text: string
  /** `lost` is the turn that was thrown away; `waiting` is a message behind it. */
  state: "lost" | "waiting"
  /** The state in the reader's words. */
  label: string
}

/** How much of a held message a row shows: enough to know which one it is. */
export const ROW_TEXT_CHARS = 200
export const EMPTY_TEXT = "An empty message"

export const LOST_LABEL = "Lost when the server restarted"
export const WAITING_LABEL = "Waiting"

export const PAUSED_TITLE = "This session's queue is paused."
export const PAUSED_BODY =
  "A turn didn't finish when the server restarted, and nothing behind it runs until it's discarded."
export const PAUSED_NOTE = "The lost message stays in the transcript."
export const DISCARD_LABEL = "Discard lost turn"

/**
 * What the card draws, or undefined while nothing is held: a queue still moving draws nothing,
 * since its messages are already in the thread waiting their turn.
 */
export function pausedQueue(queue: PendingQueue | undefined) {
  if (!queue?.paused || !queue.items.length) return undefined
  return {
    lost: queue.lost,
    rows: queue.items.map(
      (item): PendingRow => ({
        id: item.id,
        text: item.text,
        state: item.status === "unknown" ? "lost" : "waiting",
        label: item.status === "unknown" ? LOST_LABEL : WAITING_LABEL,
      }),
    ),
  }
}

/** How many messages a discard sets free: everything waiting behind the lost turn. */
export function releasedBy(queue: PendingQueue | undefined) {
  if (!pausedQueue(queue)) return 0
  return queue!.items.filter((item) => item.status === "queued").length
}

/** The words a held message shows: its own line, or that it has none to show. */
export function rowLine(text: string) {
  return oneLine(text, ROW_TEXT_CHARS) ?? EMPTY_TEXT
}
