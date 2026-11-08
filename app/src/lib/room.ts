import { useLiveQuery } from "dexie-react-hooks"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { hasServer, serverConfig } from "@/lib/connection"
import {
  ROOM_LOG_ROWS,
  db,
  type Attachment,
  type Conversation,
  type Profile,
  type RoomAttachment,
  type RoomEvent,
  type RoomMember,
  type RoomNeeds,
} from "@/lib/db"
import { chatOwner } from "@/lib/chat-owner"
import { equal } from "@/lib/equal"
import { CHAT_IDLE_MS, CHAT_POLL_MS, ROOM_NEEDS_MS } from "@/lib/freshness"
import {
  HermesError,
  answerRoom,
  approveRoom,
  getRoom,
  sendRoomMessage,
  stopRoom,
  uploadRoomAttachment,
  type RoomApproval,
  type RoomAsked,
  type RoomAsk,
  type HermesConfig,
} from "@/lib/hermes"
import { onChanges, useChanges } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { AttachmentError } from "@/lib/send-turn"
import { randomId } from "@/lib/utils"
import {
  askingEvent,
  askingMember,
  foldRoom,
  newestSeq,
  queuedMembers,
  workingLine,
  workingMembers,
} from "@/lib/room-log"

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

/** How many of the plugin's answers one read follows, so a long room can't be read in one go. */
const MAX_PAGES = 5

/** What a room's screen keeps of a read that the log itself doesn't hold. */
export interface RoomLive {
  /** The room's name as the Host answers it, which is fresher than the record's. */
  name: string
  /** The roster the Host seats, in its own order: the bubbles' names and pictures come from it. */
  members: RoomMember[]
  /** The who-is-working line, and nothing at all while the room is at rest. */
  working?: string
  /** What the room waits on the user for: an approval, or a question, and nothing at rest. */
  waiting: RoomAsk[]
  /** Whether this room's round can be stopped, and `undefined` until a read has said either way. */
  canStop?: boolean
  /** Whether this room takes a send, and `undefined` until a read has said either way. */
  canSend?: boolean
  /** The member whose reply ended addressed to `@user`, read from the log this device holds. */
  asking?: { memberId?: string; name?: string }
  /** The last read that failed, in the Host's own words, and cleared by the next good read. */
  error?: string
  /** An answer or a stop the Host refused, in its own words: it stands until the next try. */
  refused?: string
}

const EMPTY: RoomLive = { name: "", members: [], waiting: [] }

/** The index range one room's page sits in, which every read and write of it asks for. */
const pageRange = (roomId: string) =>
  db.roomLog.where("[roomId+seq]").between([roomId, 0], [roomId, Number.MAX_SAFE_INTEGER])

/** One room's rows, in the Host's order: the page this device holds. */
const page = (roomId: string) => pageRange(roomId).toArray()

/** One page of a room's words, put where a reload finds them without asking the Host. */
async function merge(roomId: string, events: RoomEvent[]): Promise<void> {
  if (!events.length) return
  await db.roomLog.bulkPut(events.map((event) => ({ roomId, ...event })))
}

/** The newest sequence this device drew: the room's read mark, and where its next read starts. */
async function readMark(roomId: string): Promise<number> {
  return (await pageRange(roomId).last())?.seq ?? 0
}

/**
 * One room's delta, followed to its newest row: the plugin answers a page at a time and says when it
 * stopped before the end, so a long room is read on until this device holds what the screen draws.
 * `MAX_PAGES` is the plugin's own page cap, so a room past it is read as far as one open goes.
 */
async function follow(
  config: HermesConfig,
  roomId: string,
  since?: number,
  signal?: AbortSignal,
) {
  let found = await getRoom(config, roomId, since, signal)
  for (let pages = 1; found.hasMore && pages < MAX_PAGES; pages += 1) {
    const next = await getRoom(config, roomId, found.cursor, signal)
    found = { ...next, events: [...found.events, ...next.events] }
  }
  return found
}

/**
 * Drops rows held above the Host's newest sequence: the Host is the only authority on what its log
 * holds, so a row above it is one it never wrote, and it would otherwise stay as the read mark.
 */
async function trim(roomId: string, latestSeq?: number) {
  if (!latestSeq) return
  if (((await pageRange(roomId).last())?.seq ?? 0) <= latestSeq) return
  await db.roomLog
    .where("[roomId+seq]")
    .between([roomId, latestSeq + 1], [roomId, Number.MAX_SAFE_INTEGER])
    .delete()
}

/**
 * Says this device has drawn a room up to `seq`, which is where its row's needs-you mark stops
 * (ADR 0116: a room's read mark never syncs). Only a room's row carries one, and only a write that
 * moves it is made, so a screen that draws nothing new costs no write.
 */
async function markSeen(roomId: string, seq: number): Promise<void> {
  const held = await db.conversations.get(roomId)
  if (!held?.room || !seq || (held.roomSeenSeq ?? 0) >= seq) return
  await db.conversations.update(roomId, { roomSeenSeq: seq })
}

/** How often one room is read for the chat list at most, however often the Host says it moved. */
const NEEDS_READ_MS = ROOM_NEEDS_MS

/**
 * The rooms a read is out for, and when each was last tried — with whether it failed. A failed read
 * keeps its stamp, so a Host that is away costs one ask a second rather than one per write of any
 * other row; a read that landed does not, so the next thing its record says is read at once.
 */
const needsReading = new Set<string>()
const needsTried = new Map<string, { at: number; failed: boolean }>()

/**
 * One room's page, read for the list rather than for the room's screen: what this device hasn't got
 * is merged into the page it keeps, and what the page ends asking for is written on the row, so a
 * room that needs the user says so before anyone opens it.
 *
 * The read mark is left where it is — only the room's own screen advances it — which is what makes
 * opening the room the move that clears the row's mark. A read that fails is not retried on the
 * next write of any other row: the room is given the same breath the Host's own changes get, so a
 * Host that is away costs one ask a second rather than one per write.
 */
async function readNeeds({ chat, bot }: RoomNeedsRow, { paced }: { paced: boolean }) {
  const id = chat.id
  if (!bot || !hasServer(bot) || needsReading.has(id)) return
  const tried = needsTried.get(id)
  // The Host's own pace for a change it announced, and a failure's pace on either path.
  if (tried && Date.now() - tried.at < NEEDS_READ_MS && (paced || tried.failed)) return
  needsReading.add(id)
  try {
    const config = serverConfig(bot)
    const found = await follow(config, id, (await readMark(id)) || undefined)
    await merge(id, found.events)
    await trim(id, found.latestSeq)
    if (found.events.length) await prune(id)
    const held = await db.conversations.get(id)
    const members = found.room.members.length
      ? found.room.members
      : (held?.room?.members ?? [])
    const asked = askingEvent(await page(id), members)
    const next: RoomNeeds = { at: chat.changedAt, ...(asked ?? {}) }
    // A reading that says what the row already says costs no write: every write wakes the lists.
    if (held?.room && !equal(held.roomNeeds, next))
      await db.conversations.update(id, { roomNeeds: next })
    needsTried.delete(id)
  } catch {
    // A room that couldn't be read says nothing new: its row keeps the reading it has, and a room
    // this device may not reach still lists (ADR 0115). Its stamp stays, so the failure is paced.
    needsTried.set(id, { at: Date.now(), failed: true })
  } finally {
    needsReading.delete(id)
  }
}

/** One room the list lists, and the bot that answers for it: what the list's reader works from. */
export interface RoomNeedsRow {
  chat: Conversation
  bot?: Profile
  /** The record's clock this device last read the room's page at, or nothing before it has. */
  read?: number
}

/**
 * Keeps the chat list's rooms read: a room whose record moved since this device last read its page,
 * and every listed room the Host says has moved — one read a second per room at most, and none at
 * all for a room at rest.
 *
 * A room's record carries its name, its roster and its last activity (ADR 0116), and no word about
 * what it waits on: the Host's own state is read from its log, so the row's mark is the device's
 * reading of that page against the mark of what it has drawn.
 *
 * Returns the rooms it lists, so the list that draws them reads the table once.
 */
export function useRoomNeeds(): RoomNeedsRow[] | undefined {
  const rooms = useLiveQuery(async () => {
    const bots = new Map((await db.profiles.toArray()).map((one) => [one.id, one]))
    const held = await db.conversations.filter((chat) => Boolean(chat.room)).toArray()
    return held
      .filter((chat) => chatOwner(chat, bots).listed)
      .map((chat) => ({
        chat,
        bot: chatOwner(chat, bots).bot,
        read: chat.roomNeeds?.at,
      }))
  }, [])
  const current = useRef(rooms)
  useEffect(() => {
    current.current = rooms
  }, [rooms])

  // A room whose row moved has words this device hasn't read: the page is read, and the row's mark
  // follows whatever the newest reply in it ends on.
  useEffect(() => {
    for (const room of rooms ?? []) {
      if (room.bot && room.read !== room.chat.changedAt) void readNeeds(room, { paced: false })
    }
  }, [rooms])

  // The Host says a room moved: its log has a row this device hasn't got, and the record may not
  // reach it yet — the stream does, which is what makes the mark stand on a room nobody opened.
  useEffect(
    () =>
      onChanges("room", () => {
        for (const room of current.current ?? []) if (room.bot) void readNeeds(room, { paced: true })
      }),
    [],
  )
  return rooms
}

/**
 * Keeps one room's page to its bound, oldest first: a room's log lives on its Host and is read back
 * by sequence, so what a device holds is the page a reader can scroll, not the room's history.
 */
async function prune(roomId: string): Promise<void> {
  const held = await db.roomLog.where("roomId").equals(roomId).count()
  if (held <= ROOM_LOG_ROWS) return
  const keys = await pageRange(roomId).primaryKeys()
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
  /** The page has already been dropped for a refused mark, so a bad room doesn't clear it a tick. */
  const reset = useRef(false)
  /**
   * The message a send failed to land, and what it was minted: its words and files as a retry names
   * them, the Host's event id, and per file its upload id with the manifest the Host answered for it.
   * A retry must reuse all of them — the Host binds an event id to its content, so the same message
   * lands once, and a file whose manifest is already in hand is not uploaded again: the upload id
   * makes the Host's store idempotent, but every byte of a re-sent file is still the wire's.
   */
  const failed = useRef<{
    key: string
    eventId: string
    uploads: Map<string, { uploadId: string; manifest?: RoomAttachment }>
  } | undefined>(undefined)

  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!roomId || !hasServer(bot) || reading.current) return
      reading.current = true
      try {
        const found = await follow(config, roomId, (await readMark(roomId)) || undefined, signal)
        await merge(roomId, found.events)
        await prune(roomId)
        reset.current = false
        // The Host is the only authority on what its log holds: a row this device drew above the
        // Host's newest sequence is one it never wrote, so it goes rather than staying the read mark.
        await trim(roomId, found.latestSeq)
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
            waiting: found.waiting,
            canStop: found.canStop,
            canSend: found.canSend,
            // A refusal is the write's, not the read's: a good read does not take its words away.
            ...(held.refused ? { refused: held.refused } : {}),
          }
          return equal(next, held) ? held : next
        })
      } catch (error) {
        // A read that failed is no claim about the room: the working line goes rather than pinning
        // the screen at a turn's pace for as long as the Host is away. A Host that refused the ask
        // itself has a log this device's mark is past — a restored store, a replaced room — so the
        // page goes once and is read again from nothing, and the room stops taking sends.
        const refused = error instanceof HermesError && error.status === 400
        if (refused && roomId && !reset.current) {
          reset.current = true
          await db.roomLog.where("roomId").equals(roomId).delete()
        }
        setLive((held) => ({
          ...held,
          working: undefined,
          ...(refused ? { canSend: false } : {}),
          error: reasonOf(error),
        }))
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
      if (reading.current) {
        // A change heard while a read is out books the next one for when the window opens, rather
        // than waiting out a poll interval for a state that is already known to have moved.
        trailing.current = window.setTimeout(() => {
          lastRead.current = Date.now()
          void read()
        }, ROOM_READ_MS)
        return
      }
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

  /**
   * One message into the room: its words, and the files it carries.
   *
   * A file goes to the Host's room store first, under an upload id this device minted, and the
   * message then names what came back — the store is the only place a room's bytes live, so a
   * manifest is all the log ever holds. The message's id, each file's id and the manifest it was
   * answered with are kept until it lands, so a retry after a dropped answer is the same message and
   * the same files rather than a second copy of either — and the bytes of a file already stored are
   * not sent again. A Host that refuses a file says so in its own words, through the room's banner,
   * and the error is thrown as itself — naming the staged file — so the composer can mark that tile
   * and tell the reader, rather than only saying the message didn't go.
   */
  const send = useCallback(
    async (text: string, attachments: Attachment[] = []): Promise<void> => {
      const words = text.trim()
      const carried = attachments.filter(
        (file): file is Attachment & { blob: Blob } => Boolean(file.blob),
      )
      if (!roomId || !hasServer(bot) || (!words && !carried.length)) return
      try {
        // The ids are minted here and kept with the message, so a send retried after a dropped
        // answer is the Host's same message rather than a second one. A message the user changed —
        // its words, or the files it carries — is a new one: the Host binds an id to its content,
        // and would refuse the old id for it.
        const key = [words, ...carried.map((file) => file.id)].join("\u0000")
        const reused = failed.current?.key === key ? failed.current : undefined
        const eventId = reused?.eventId ?? randomId()
        const uploads =
          reused?.uploads ??
          new Map<string, { uploadId: string; manifest?: RoomAttachment }>()
        failed.current = { key, eventId, uploads }
        const manifests: RoomAttachment[] = await Promise.all(
          carried.map(async (file) => {
            const kept = uploads.get(file.id)
            // A file whose manifest the Host already answered is named by it: the message this
            // retry sends is the same one, so the bytes it would upload are already stored.
            if (kept?.manifest) return kept.manifest
            const uploadId = kept?.uploadId ?? randomId()
            uploads.set(file.id, { uploadId })
            let manifest: RoomAttachment
            try {
              manifest = await uploadRoomAttachment(
                config,
                roomId,
                { name: file.name, type: file.type, blob: file.blob },
                uploadId,
              )
            } catch (error) {
              // The Host refused this file, not the message: the error names the staged file so the
              // composer can mark its tile and the reader can take it off, and so a retry that keeps
              // it says the Host's words again rather than a sentence about the whole message.
              throw new AttachmentError(reasonOf(error), file.id)
            }
            uploads.set(file.id, { uploadId, manifest })
            return manifest
          }),
        )
        const sent = await sendRoomMessage(config, roomId, eventId, words, manifests)
        const held = await readMark(roomId)
        // The Host's own event goes on the page at once, and only where it is the next row this
        // device was owed: a page with a hole in it would leave the rows before it unreadable.
        if (sent && sent.seq === held + 1) await merge(roomId, [sent])
        failed.current = undefined
      } catch (error) {
        // A refused send is said where the user's own move is: a file the Host won't take marks its
        // tile and is a toast (the composer's), and anything else about the message is a toast from
        // the room's screen. Nothing here keeps a banner, so a refusal is not said twice.
        throw error
      } finally {
        sync(undefined, true)
      }
    },
    [roomId, bot, config, sync],
  )

  /**
   * One answer into the room — an approval, a question, or a stop — and a read the moment it lands,
   * since what the room waits on is the Host's own state and not this device's guess. A refusal
   * stays on screen in the Host's words, as a refused send does.
   */
  const act = useCallback(
    async (work: () => Promise<void>): Promise<boolean> => {
      if (!roomId || !hasServer(bot)) return false
      setLive((held) => ({ ...held, refused: undefined }))
      try {
        await work()
        return true
      } catch (error) {
        setLive((held) => ({ ...held, refused: reasonOf(error) }))
        return false
      } finally {
        sync(undefined, true)
      }
    },
    [roomId, bot, sync],
  )

  const approve = useCallback(
    (approval: RoomApproval, choice: "once" | "deny") =>
      roomId
        ? act(() => approveRoom(config, roomId, approval, choice))
        : Promise.resolve(false),
    [roomId, config, act],
  )

  const answer = useCallback(
    (asked: RoomAsked, answers: Record<string, string | string[]>) =>
      roomId ? act(() => answerRoom(config, roomId, asked, answers)) : Promise.resolve(false),
    [roomId, config, act],
  )

  const stop = useCallback(
    () =>
      roomId
        ? act(() => stopRoom(config, roomId, randomId()))
        : Promise.resolve(false),
    [roomId, config, act],
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
  const asking = useMemo(() => askingMember(rows ?? [], members), [rows, members])
  // Drawing the room is reading it: the newest row on screen is this device's mark, and the list's
  // needs-you mark stops there (ADR 0116's read mark, kept where the row that reads it lives).
  const drawn = useMemo(() => newestSeq(folded), [folded])
  useEffect(() => {
    if (roomId && drawn) void markSeen(roomId, drawn)
  }, [roomId, drawn])
  return {
    live: { ...live, members, asking },
    rows: folded,
    send,
    approve,
    answer,
    stop,
  }
}
