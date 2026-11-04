import { useLiveQuery } from "dexie-react-hooks"
import { useMemo } from "react"
import { toast } from "sonner"

import { Compacted } from "@/components/chat/model-change"
import { MovedMarker } from "@/components/chat/moved-marker"
import { db, type Message } from "@/lib/db"
import type { Move } from "@/lib/hermes"
import { type CompactionMarks } from "@/lib/compactions"
import { dayKey, dayOf } from "@/lib/days"
import { mainTail, orderTail, tailId, tailItems, type TailItem } from "@/lib/main-tail"
import { moveMarks, openedThread } from "@/lib/move-marks"
import { undoMove } from "@/lib/moves"
import { drawnThreadIds, threadCards } from "@/lib/thread-cards"
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
  compacted,
  on,
  listFor,
  afterUndo,
  routeChat,
}: {
  chatId?: string
  profileId: string
  thread: Message[] | undefined
  moves: Move[] | undefined
  /** Where the host compacted this chat, from `compactionMarks`: a divider above a message, or the end. */
  compacted?: CompactionMarks
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
  // Read by `thread`, which is undefined exactly until the chat's own read answers: a divider drawn
  // over a chat still reading leads the rows about to arrive, then jumps above them.
  const tail = useMemo(
    () =>
      mainTail({
        cards: cards?.trailing,
        moves: marks.trailing,
        compaction: thread ? compacted?.trailing : undefined,
      }),
    [cards, marks, compacted, thread],
  )
  const now = useNow()
  const flow = useMemo(() => {
    const entries: FlowEntry[] = []
    let day: number | undefined
    const heading = (at: number) => {
      if (!cards) return
      const key = dayKey(at)
      if (key === day) return
      day = key
      entries.push({ kind: "heading", day: dayOf(at, now), at })
    }
    /**
     * What stands above one message: the cards, the markers and a divider each producer placed
     * there, in the one order their own times give — three lists stacked is a card begun after a
     * move drawn above it (ADR 0097).
     */
    const above = (message: Message): TailItem[] => {
      const items = tailItems({
        cards: cards?.before.get(message.id),
        moves: marks.before.get(message.id),
        compaction: thread ? compacted?.before.get(message.id) : undefined,
      })
      return items.length > 1 ? orderTail(items) : items
    }
    for (const message of thread ?? NO_ROWS) {
      for (const item of above(message)) {
        heading(item.at)
        entries.push(item)
      }
      heading(message.createdAt)
      entries.push({ kind: "message", message })
    }
    for (const item of tail) {
      heading(item.at)
      entries.push(item)
    }
    return entries
  }, [cards, compacted, marks, thread, tail, now])
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
  /**
   * A flow entry that is not a card: a Moved marker, or a compaction's divider. Its key is the id the
   * flow orders by, so two items at one moment keep their places between renders (ADR 0097).
   */
  const itemRow = (item: Exclude<TailItem, { kind: "card" }>) =>
    item.kind === "move" ? (
      <MovedMarker
        key={tailId(item)}
        move={item.move}
        title={movedTitles?.get(item.move.threadId)}
        profileId={profileId}
        current={item.move.threadId === routeChat}
        onUndo={undo}
      />
    ) : (
      <Compacted key={tailId(item)} compaction={item.compaction} />
    )
  return {
    threadList,
    flow,
    moveThatOpenedThread,
    undo,
    itemRow,
  }
}
