import { useLiveQuery } from "dexie-react-hooks"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { hasServer, serverConfig } from "@/lib/connection"
import {
  ROOM_LOG_ROWS,
  db,
  type Conversation,
  type Profile,
  type RoomEvent,
  type RoomMember,
} from "@/lib/db"
import { equal } from "@/lib/equal"
import { CHAT_IDLE_MS, CHAT_POLL_MS } from "@/lib/freshness"
import { getRoom, sendRoomMessage } from "@/lib/hermes"
import { useChanges } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { foldRoom, newestSeq, queuedMembers, workingLine, workingMembers } from "@/lib/room-log"

/**
 * A room on this device (ADR 0116): its words are the Host's log, read by sequence and kept on the
 * device once drawn; its live state — who is answering, whether it takes a send — is what the last
 * read said and nothing of this device's own.
 *
 * The app is never in the loop the Host works in. A send is one append; the rounds run on the Host
 * with no client attached; every change the Host reports makes this screen read the room again.
 */

/**
 * How often a room is read at most, however often it says it moved. A member's turn fires the
 * Host's activity hook several times a second, and a screen that read once per frame would spend a
 * round's whole tool loop in reads it cannot draw: the window turns that into one read a second,
 * which is still faster than the eye needs for a working line.
 */
const ROOM_READ_MS = 1_000

/** What a room's screen keeps of a read that the log itself doesn't hold. */
export interface RoomLive {
  /** The room's name as the Host answers it, which is fresher than the record's. */
  name: string
  /** The roster the Host seats, in its own order: the bubbles' names and pictures come from it. */
  members: RoomMember[]
  /** The who-is-working line, and nothing at all while the room is at rest. */
  working?: string
  /** Whether this room takes a send, and `undefined` until a read has said either way. */
  canSend?: boolean
  /** The last read or send that failed, in its own words. */
  error?: string
  /** A send on its way to the Host. */
  sending: boolean
}

const EMPTY: RoomLive = { name: "", members: [], sending: false }

/** One room's rows, in the Host's order: the page this device holds. */
function page(roomId: string) {
  return db.roomLog
    .where("[roomId+seq]")
    .between([roomId, 0], [roomId, Number.MAX_SAFE_INTEGER])
    .toArray()
}

/** One page of a room's words, put where a reload finds them without asking the Host. */
async function merge(roomId: string, events: RoomEvent[]): Promise<void> {
  if (!events.length) return
  await db.roomLog.bulkPut(events.map((event) => ({ roomId, ...event })))
}

/** The newest sequence this device drew: the room's read mark, and where its next read starts. */
async function readMark(roomId: string): Promise<number> {
  const last = await db.roomLog
    .where("[roomId+seq]")
    .between([roomId, 0], [roomId, Number.MAX_SAFE_INTEGER])
    .last()
  return last?.seq ?? 0
}

/**
 * Keeps one room's page to its bound, oldest first: a room's log lives on its Host and is read back
 * by sequence, so what a device holds is the page a reader can scroll, not the room's history.
 */
async function prune(roomId: string): Promise<void> {
  const held = await db.roomLog.where("roomId").equals(roomId).count()
  if (held <= ROOM_LOG_ROWS) return
  const keys = await db.roomLog
    .where("[roomId+seq]")
    .between([roomId, 0], [roomId, Number.MAX_SAFE_INTEGER])
    .primaryKeys()
  await db.roomLog.bulkDelete(keys.slice(0, held - ROOM_LOG_ROWS))
}

/** What a failed read or send says: the error's own words, else the room's. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The room's host didn't answer."
}

/**
 * A room's screen: its rows folded from the device's page of the log, and the live state of the
 * Host's last answer.
 *
 * `chat` is the record the chat list merged — its `room` is the roster a device draws before the
 * Host has answered — and `bot` is the member that answers for it, which is who every read and send
 * is made as. A room with no answerer draws nothing: its record is still the Host's, and no bot of
 * this device may speak for it (ADR 0115).
 */
export function useRoom(chat: Conversation | undefined, bot: Profile | undefined) {
  const roomId = chat?.id
  const config = useMemo(() => serverConfig(bot), [bot])
  const [live, setLive] = useState<RoomLive>(EMPTY)
  const rows = useLiveQuery(async () => (roomId ? await page(roomId) : []), [roomId])
  const changes = useChanges("room", bot)
  const reading = useRef(false)
  const lastRead = useRef(0)
  const trailing = useRef<number | undefined>(undefined)

  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!roomId || !hasServer(bot) || reading.current) return
      reading.current = true
      try {
        const found = await getRoom(config, roomId, (await readMark(roomId)) || undefined, signal)
        await merge(roomId, found.events)
        await prune(roomId)
        // The Host is the only authority on what its log holds: a row this device drew above the
        // Host's newest sequence is one it never wrote, so it goes rather than staying the read mark.
        if (found.latestSeq && newestSeq(await page(roomId)) > found.latestSeq) {
          await db.roomLog
            .where("[roomId+seq]")
            .between([roomId, found.latestSeq + 1], [roomId, Number.MAX_SAFE_INTEGER])
            .delete()
        }
        const members = found.room.members.length
          ? found.room.members
          : (chat?.room?.members ?? [])
        setLive((held) => {
          const next: RoomLive = {
            name: found.room.name || held.name,
            members,
            working: workingLine(
              workingMembers(members, found.activity),
              queuedMembers(members, found.activity),
              found.working,
            ),
            canSend: found.canSend,
            sending: held.sending,
          }
          return equal(next, held) ? held : next
        })
      } catch (error) {
        // A read that failed is no claim about the room: the working line goes rather than pinning
        // the screen at a turn's pace for as long as the Host is away.
        setLive((held) => ({ ...held, working: undefined, error: reasonOf(error) }))
      } finally {
        reading.current = false
      }
    },
    [roomId, chat, config, bot],
  )

  /**
   * Asks for a read, at most one window apart: a frame that lands inside the window books the read
   * for when it opens instead of starting one now, so a round's frames cost one read a second
   * however fast the Host reports them. `now` skips the window, which is what a send asks.
   */
  const sync = useCallback(
    (signal?: AbortSignal, now = false) => {
      if (!roomId || !hasServer(bot)) return
      window.clearTimeout(trailing.current)
      const wait = now ? 0 : lastRead.current + ROOM_READ_MS - Date.now()
      if (wait <= 0) {
        lastRead.current = Date.now()
        void read(signal)
        return
      }
      trailing.current = window.setTimeout(() => {
        lastRead.current = Date.now()
        void read()
      }, wait)
    },
    [roomId, bot, read],
  )

  useEffect(() => () => window.clearTimeout(trailing.current), [])

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!roomId || !hasServer(bot) || !text.trim()) return false
      setLive((held) => ({ ...held, sending: true, error: undefined }))
      try {
        // The id is minted here, so a send retried after a dropped answer is this same message.
        const sent = await sendRoomMessage(config, roomId, crypto.randomUUID(), text.trim())
        // A 200 can carry a message the Host did not take: the words stay in the field and nothing
        // of it reaches the page, since a row the Host never wrote would become the read mark.
        if (!sent.accepted) throw new Error("This room's host didn't take the message.")
        const held = await readMark(roomId)
        // The Host's own event goes on the page at once, and only where it is the next row this
        // device was owed: a page with a hole in it would leave the rows before it unreadable.
        if (sent.event && sent.event.seq === held + 1) await merge(roomId, [sent.event])
        return true
      } catch (error) {
        setLive((held) => ({ ...held, error: reasonOf(error) }))
        return false
      } finally {
        setLive((held) => ({ ...held, sending: false }))
        sync(undefined, true)
      }
    },
    [roomId, bot, config, sync],
  )

  // One read as the screen opens, another each time the Host says the room moved, and the poll as
  // the net under a dropped stream: a room whose turn is running reads at a chat's pace, and one at
  // rest reads slowly.
  usePoll((signal) => sync(signal), live.working ? CHAT_POLL_MS : CHAT_IDLE_MS, [sync, changes])

  const members = useMemo(
    () => (live.members.length ? live.members : (chat?.room?.members ?? [])),
    [live.members, chat],
  )
  const folded = useMemo(() => foldRoom(rows ?? [], members), [rows, members])
  return { live: { ...live, members }, rows: folded, send }
}
