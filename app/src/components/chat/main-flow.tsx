import { useLiveQuery } from "dexie-react-hooks"
import { useMemo } from "react"
import { toast } from "sonner"

import { MovedMarker } from "@/components/chat/moved-marker"
import { db, type Message } from "@/lib/db"
import type { Move } from "@/lib/hermes"
import { dayOf } from "@/lib/days"
import { moveMarks, openedThread } from "@/lib/move-marks"
import { undoMove } from "@/lib/moves"
import { drawnThreadIds, threadCards } from "@/lib/thread-cards"
import { useNow, useThreads, type Thread } from "@/lib/threads"

export type FlowEntry =
  | { kind: "heading"; day: string; at: number }
  | { kind: "card"; thread: Thread }
  | { kind: "message"; message: Message }

const NO_ROWS: Message[] = []

/**
 * A bot's Main as one flow, whichever screen draws it: its messages with each thread's card above
 * the first message written after that thread began, a day heading over the first thing each day
 * holds, and the moves that left a Moved marker. Off, it is the thread's messages and nothing more.
 */
export function useMainFlow({
  chatId,
  profileId,
  thread,
  moves,
  on,
  listFor,
  afterUndo,
  routeChat,
}: {
  chatId?: string
  profileId: string
  thread: Message[] | undefined
  moves: Move[] | undefined
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
        heading(card.chat.createdAt)
        entries.push({ kind: "card", thread: card })
      }
      heading(message.createdAt)
      entries.push({ kind: "message", message })
    }
    for (const card of cards?.trailing ?? []) {
      heading(card.chat.createdAt)
      entries.push({ kind: "card", thread: card })
    }
    return entries
  }, [cards, thread, now])
  const moved = useMemo(
    () => moveMarks(thread ?? NO_ROWS, moves, drawnAsCards),
    [thread, moves, drawnAsCards],
  )
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
  return { threadList, cards, flow, moved, moveThatOpenedThread, undo, marker }
}
