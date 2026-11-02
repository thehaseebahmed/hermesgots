import { useLiveQuery } from "dexie-react-hooks"
import { useMemo } from "react"
import { toast } from "sonner"

import { Compacted } from "@/components/chat/model-change"
import { MovedMarker } from "@/components/chat/moved-marker"
import { db, type Message } from "@/lib/db"
import type { Compaction, Move } from "@/lib/hermes"
import { compactionAt } from "@/lib/compactions"
import { dayOf } from "@/lib/days"
import { mainTail, type TailItem } from "@/lib/main-tail"
import { moveMarks, openedThread } from "@/lib/move-marks"
import { undoMove } from "@/lib/moves"
import { drawnThreadIds, cardAt, threadCards } from "@/lib/thread-cards"
import { useNow, useThreads } from "@/lib/threads"

export type FlowEntry =
  { kind: "heading"; day: string; at: number } | { kind: "message"; message: Message } | TailItem

const NO_ROWS: Message[] = []

/**
 * A bot's Main as one flow, whichever screen draws it: its messages with each thread's card above
 * the first message written after that thread began, a day heading over the first thing each day
 * holds, and the moves that left a Moved marker. What no message follows runs on after the messages
 * as one timeline — a card, a marker and a compaction's divider in the order they happened, never
 * as one block per kind — which is why the tail is the flow's and the screens no longer append
 * their own. Off, it is the thread's messages and the markers that trail them.
 */
export function useMainFlow({
  chatId,
  profileId,
  thread,
  moves,
  compaction,
  on,
  listFor,
  afterUndo,
  routeChat,
}: {
  chatId?: string
  profileId: string
  thread: Message[] | undefined
  moves: Move[] | undefined
  /** What closes the flow: `compactionMarks`' own trailing, when the host left one. */
  compaction?: Compaction
  /** Main draws its threads as cards. */
  on: boolean
  /** The bot whose threads are read, where something other than the cards needs the list. */
  listFor?: string
  /** What the screen reads again once a move is undone. */
  afterUndo?: (chatId: string) => unknown
  /** The thread the address names, whose marker leads nowhere. */
  routeChat?: string
}) {
  const threadList = useThreads(on ? profileId : listFor)
  const cards = useMemo(
    () => (on ? threadList && threadCards(thread ?? NO_ROWS, threadList) : undefined),
    [on, thread, threadList],
  )
  const drawnAsCards = useMemo(() => drawnThreadIds(cards), [cards])
  const marks = useMemo(
    () => moveMarks(thread ?? NO_ROWS, moves, drawnAsCards),
    [thread, moves, drawnAsCards],
  )
  const tail = useMemo(
    () =>
      mainTail({
        cards: cards?.trailing,
        moves: marks.trailing,
        // Held until the chat's own read answers: a divider over a chat still reading leads the rows
        // about to arrive, then jumps above them. `thread` is undefined exactly until it has answered.
        compaction: thread ? compaction : undefined,
      }),
    [cards, marks, compaction, thread],
  )
  const now = useNow()
  const flow = useMemo(() => {
    const entries: FlowEntry[] = []
    let day: string | undefined
    const heading = (at: number) => {
      if (!cards) return
      const label = dayOf(at, now)
      if (label === day) return
      day = label
      entries.push({ kind: "heading", day: label, at })
    }
    for (const message of thread ?? NO_ROWS) {
      for (const card of cards?.before.get(message.id) ?? []) {
        heading(cardAt(card))
        entries.push({ kind: "card", at: cardAt(card), thread: card })
      }
      heading(message.createdAt)
      entries.push({ kind: "message", message })
    }
    for (const item of tail) {
      heading(item.at)
      entries.push(item)
    }
    return entries
  }, [cards, thread, tail, now])
  const moveThatOpenedThread = useMemo(() => {
    const found = new Map<string, Move>()
    for (const move of moves ?? []) {
      const threadId = openedThread(move)
      if (threadId) found.set(threadId, move)
    }
    return found
  }, [moves])
  // One query for every moved-to thread's title, not one per marker: a write to any conversation
  // re-runs a live query.
  const movedIds = useMemo(() => [...new Set(moves?.map((m) => m.threadId))].sort(), [moves])
  const movedTitles = useLiveQuery(
    async () =>
      new Map(
        (await db.conversations.bulkGet(movedIds)).flatMap((c) => (c ? [[c.id, c.title]] : [])),
      ),
    [movedIds],
  )
  const undo = (move: Move) =>
    chatId &&
    void undoMove(chatId, move.id)
      .then(() => afterUndo?.(chatId))
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Couldn't undo the move"),
      )
  const marker = (move: Move) => (
    <MovedMarker
      key={move.id}
      move={move}
      title={movedTitles?.get(move.threadId)}
      profileId={profileId}
      current={move.threadId === routeChat}
      onUndo={undo}
    />
  )
  /** A tail entry that is not a card: a Moved marker, or the divider closing the flow. */
  const tailRow = (item: Exclude<TailItem, { kind: "card" }>) =>
    item.kind === "move" ? (
      marker(item.move)
    ) : (
      <Compacted key={`compaction-${compactionAt(item.compaction)}`} compaction={item.compaction} />
    )
  return {
    threadList,
    flow,
    markersAbove: marks.before,
    moveThatOpenedThread,
    undo,
    marker,
    tailRow,
  }
}
