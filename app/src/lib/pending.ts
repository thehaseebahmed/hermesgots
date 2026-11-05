/**
 * The queue Hermes itself keeps for a session, as the chat draws it: the inputs still in line, and
 * the turn a restart lost out from under them.
 *
 * Hermes admits every prompt to a session's own FIFO rather than refusing it while a turn runs, and
 * a turn whose owner restarted mid-execution is fenced `unknown` — nothing behind it runs until it
 * is acknowledged (the TUI's `/discard`). So a chat can sit holding a message that will never start,
 * which is what this card says out loud, with the one control that clears it.
 *
 * Import-free but for `equal.ts` and the one-line rule (`words.ts`), so `scripts/test-pending.mjs`
 * runs it as a pure rule.
 */

import { oneLine } from "./words.ts"

/** One input the host holds for a session: the words its sender typed. */
export type PendingInput = {
  id: string
  text: string
}

export type PendingQueue = {
  items: PendingInput[]
  /** The row the host can't say finished, and the one that holds everything behind it. */
  lost: string | null
  /**
   * The host is executing a turn for this session. A thread that is still empty is being written
   * rather than missing, so it must not be called a failed read.
   */
  running: boolean
}

/** Why a row is held: the turn a restart lost, or a message waiting behind it. */
export type PendingState = "lost" | "waiting"

/** A row of the card: what the host holds, and why it's held. */
export type PendingRow = {
  id: string
  text: string
  state: PendingState
}

/** How much of a held message a row shows: enough to know which one it is. */
export const ROW_TEXT_CHARS = 200
export const EMPTY_TEXT = "An empty message"

/** Each state's one word. One table, so a row's word and its class can't drift apart. */
export const ROW_LABEL: Record<PendingState, string> = {
  lost: "Lost when the server restarted",
  waiting: "Waiting",
}

export const PAUSED_TITLE = "This session's queue is paused."
export const PAUSED_BODY =
  "A turn didn't finish when the server restarted, and nothing behind it runs until it's discarded."
export const PAUSED_NOTE = "The lost message stays in the transcript."
export const DISCARD_LABEL = "Discard lost turn"
export const STALE_NOTE = "The host isn't answering, so it can't be cleared right now."

/**
 * What the card draws, or undefined while nothing is held: a queue still moving draws nothing,
 * since its messages are already in the thread waiting their turn. The host names the row that
 * holds the queue, and that name decides which row reads as lost — a later `unknown` waits its turn
 * behind it like any other.
 */
export function pausedQueue(queue: PendingQueue | undefined) {
  if (!queue?.lost) return undefined
  return {
    lost: queue.lost,
    rows: queue.items.map(
      (item): PendingRow => ({
        id: item.id,
        text: item.text,
        state: item.id === queue.lost ? "lost" : "waiting",
      }),
    ),
  }
}


/** The words a held message shows: its own line, or that it has none to show. */
export function rowLine(text: string) {
  return oneLine(text, ROW_TEXT_CHARS) ?? EMPTY_TEXT
}
