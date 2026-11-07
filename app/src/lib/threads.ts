import Dexie from "dexie"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { matchPath, useLocation, useNavigate } from "react-router"

import {
  createConversation,
  db,
  getSettings,
  listEnabledProfiles,
  mainThreadId,
  mainThreadProfile,
  type BotSort,
  type Conversation,
  type ModelChoice,
  type Profile,
  type Unsent,
} from "@/lib/db"
import { useXLarge } from "@/lib/media"
import { createStore } from "@/lib/store"
import { byName } from "@/lib/compare"
import { oneLine } from "@/lib/words"
import { withDir, type Sort, type SortKey } from "@/lib/sort"
import { useStoredSort } from "@/lib/use-sort"
import { isUnread, threadState, type ThreadState } from "@/lib/session-work"
import { useReadMarks } from "@/lib/read-marks"
import {
  useAllLiveRuns,
  useLiveSubagents,
  useLiveWaking,
  useWaiting,
  type WaitingReason,
} from "@/lib/waiting"

/** How many of a bot's newest threads its screen lists, and Main draws as cards. */
const THREADS = 50

/**
 * The message a bot's Main hands a thread it opens with `/thread`, and that thread's screen sends:
 * its words, its files, and when the reader sent it — so a thread opened a minute later still stamps
 * its opener, and stands its card, at the moment the words were typed.
 */
export type ThreadStart = Pick<Unsent, "text" | "attachments" | "at">

/**
 * Messages Main has handed the threads it opened, by thread id, until each thread's own screen takes
 * its own. Kept beside the address rather than in it: the address is one for every screen mounted at
 * once (a bot's Main beside its thread reads the same one), and a handover taken from it would be
 * taken by whichever screen rendered first — stripping it before the thread could send, or sending
 * it twice from two instances after a remount (ADR 0096).
 */
const handed = new Map<string, ThreadStart>()

export function handOver(threadId: string, start: ThreadStart) {
  handed.set(threadId, start)
}

/** The message this thread was opened to send, once: the caller that takes it is the one that sends. */
export function takeHandover(threadId: string): ThreadStart | undefined {
  const start = handed.get(threadId)
  handed.delete(threadId)
  return start
}

/**
 * A thread a bot's Main starts with `/thread`: its record, made with the model the composer holds,
 * and the message its own screen is to send as the thread's first turn.
 */
export async function beginThread(
  profileId: string,
  {
    modelChoice,
    text,
    attachments = [],
  }: { modelChoice?: ModelChoice } & Pick<ThreadStart, "text" | "attachments">,
) {
  const thread = await createConversation(profileId, { modelChoice })
  if (text.trim() || attachments.length) handOver(thread.id, { text, attachments, at: Date.now() })
  return thread
}

/** The time, moved on each minute, for "5 min ago" labels. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** Whether the bot-first layout is on: experimental, so only behind the Developer switch. */
export function useBotThreads() {
  return useLiveQuery(async () => {
    const settings = await getSettings()
    return Boolean(settings.developer && settings.botThreads)
  }, [])
}

export interface Thread {
  chat: Conversation
  /** What the user opened it with, when this device has the transcript. */
  opener?: string
  /** The bot's latest reply, cut to a line. */
  last?: string
  replies: number
  state: ThreadState
  reason?: WaitingReason
}

const line = (text?: string) => (text === undefined ? undefined : oneLine(text))

async function latestLine(conversationId: string) {
  const newest = await db.messages
    .where("[conversationId+createdAt]")
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
    .reverse()
    .filter((message) => Boolean(message.content.trim()))
    .first()
  return line(newest?.content)
}

/**
 * A bot's chats as threads, oldest started first so the newest sits at the bottom by the composer.
 * They keep the order they were started in, so a new message doesn't move a thread.
 *
 * `undefined` is "not answered yet": the hook hands back the answer it already had while the next
 * one lands, so a list read for another bot is no answer at all rather than no threads.
 */
export function useThreads(profileId: string | undefined): Thread[] | undefined {
  const live = useWaiting()
  const subagents = useLiveSubagents()
  const wakes = useLiveWaking()
  // The host's own account of which threads have a run in flight: a card shows a spinner for a run
  // started on another device too, where this device has no reply of its own to stream.
  const runs = useAllLiveRuns()
  const answer = useLiveQuery(async () => {
    if (!profileId) return { profileId, rows: [] }
    const chats = await db.conversations
      .where("[profileId+updatedAt]")
      .between([profileId, -Infinity], [profileId, Infinity])
      .reverse()
      .filter((c) => !c.projectId)
      .limit(THREADS)
      .toArray()
    // Each thread reads only what its card shows: its opener, its newest replies and how many.
    const rows = await Promise.all(
      chats.map(async (chat) => {
        const range = db.messages
          .where("[conversationId+createdAt]")
          .between([chat.id, Dexie.minKey], [chat.id, Dexie.maxKey])
        const [opener, latest, last, replies] = await Promise.all([
          range
            .clone()
            .filter((m) => m.role === "user")
            .first(),
          range
            .clone()
            .reverse()
            .filter((m) => m.role === "assistant")
            .first(),
          range
            .clone()
            .reverse()
            .filter((m) => m.role === "assistant" && Boolean(m.content.trim()))
            .first(),
          db.messages.where("[conversationId+role]").equals([chat.id, "assistant"]).count(),
        ])
        const local: WaitingReason | undefined =
          latest?.clarify && !latest.clarify.resolved
            ? { kind: "question", count: latest.clarify.questions.length || 1 }
            : latest?.approval && !latest.approval.resolved
              ? { kind: "approval", command: latest.approval.command }
              : undefined
        return {
          chat,
          opener: line(opener?.content) ?? line(chat.opener),
          last: line(last?.content),
          replies,
          streaming: latest?.status === "streaming",
          failed: latest?.status === "error",
          local,
        }
      }),
    )
    // Main stays first, whenever it was made.
    return {
      profileId,
      rows: rows.sort(
        (a, b) =>
          Number(Boolean(b.chat.main)) - Number(Boolean(a.chat.main)) ||
          a.chat.createdAt - b.chat.createdAt,
      ),
    }
  }, [profileId])

  return useMemo(() => {
    if (!answer || answer.profileId !== profileId) return undefined
    return answer.rows.map(({ chat, opener, last, replies, streaming, failed, local }) => {
      const reason = local ?? live[chat.hermesSessionId]
      const state = threadState({
        waiting: Boolean(reason),
        streaming,
        live: runs[chat.hermesSessionId],
        failed,
        subagents: subagents[chat.hermesSessionId],
        waking: wakes[chat.hermesSessionId],
      })
      return { chat, opener, last, replies, state, reason }
    })
  }, [answer, profileId, live, runs, subagents, wakes])
}

export interface BotSummary {
  bot: Profile
  /** Its newest thread. */
  latest?: Conversation
  /** Its Main thread, once this device has opened it. */
  main?: Conversation
  preview?: string
  /** The newest thread's latest message, cut to a line, for a bot with nothing said in Main. */
  threadLine?: string
  /** Threads waiting on the user. */
  waiting: number
  /**
   * A thread this device holds past its read mark — Main among them, and never a coding session's,
   * because the row leads to Main and previews the bot's own words (ADR 0110).
   */
  unread: boolean
}

/** The keys the sidebar's bots rank by, each with the way it reads best (ADR 0091). */
export const BOT_SORTS: readonly SortKey<BotSort>[] = [
  { key: "recent", label: "Recent", dir: "desc" },
  { key: "waiting", label: "Waiting", dir: "desc" },
  { key: "name", label: "Name", dir: "asc" },
  { key: "added", label: "Added", dir: "asc" },
]

/** The sidebar's bot order, kept on this device. */
export function useBotSort(): [Sort<BotSort>, (sort: Sort<BotSort>) => void] {
  return useStoredSort(BOT_SORTS, ["botSort", "botSortDir"])
}

const active = (summary: BotSummary) => (summary.main ?? summary.latest)?.updatedAt ?? -Infinity
const byRecent = (a: BotSummary, b: BotSummary) => active(a) - active(b)
const byAdded = (a: BotSummary, b: BotSummary) => a.bot.createdAt - b.bot.createdAt
const byBotName = (a: BotSummary, b: BotSummary) => byName(a.bot.name, b.bot.name)

/**
 * `recent`: the newest thread first, bots without one last. `waiting`: the most threads waiting on
 * the user first, then recent. `name`: A to Z. `added`: the order the bots were linked in. The arrow
 * turns the result round, and each key keeps its own tie-break, which the arrow turns with it.
 */
export function sortBots(bots: BotSummary[], sort: Sort<BotSort>): BotSummary[] {
  const rank = (a: BotSummary, b: BotSummary) => {
    if (sort.key === "recent") return byRecent(a, b) || byBotName(a, b)
    if (sort.key === "waiting") return a.waiting - b.waiting || byRecent(a, b) || byBotName(a, b)
    if (sort.key === "name") return byBotName(a, b)
    return byAdded(a, b)
  }
  return [...bots].sort((a, b) => withDir(rank(a, b), sort.dir))
}

/**
 * Every bot that's turned on, with its newest thread and — once this device has opened it — its
 * Main thread and the line it last said, for the sidebar, in the order linked. Its dot reads the
 * same threads, never a coding session's: a row that leads to Main must not say its news is in a
 * screen it cannot reach.
 */
export function useBotSummaries(): BotSummary[] | undefined {
  const live = useWaiting()
  const marks = useReadMarks()
  const rows = useLiveQuery(async () => {
    const bots = await listEnabledProfiles()
    return Promise.all(
      bots.map(async (bot) => {
        const chats = await db.conversations
          .where("[profileId+updatedAt]")
          .between([bot.id, -Infinity], [bot.id, Infinity])
          .reverse()
          .filter((c) => !c.projectId)
          .limit(THREADS)
          .toArray()
        // Only a chat's newest reply can wait on the user, so only that one is read.
        const newest = await Promise.all(
          chats.map((c) =>
            db.messages
              .where("[conversationId+createdAt]")
              .between([c.id, Dexie.minKey], [c.id, Dexie.maxKey])
              .reverse()
              .filter((m) => m.role === "assistant")
              .first(),
          ),
        )
        const local = new Set(
          newest
            .filter(
              (m) =>
                !!(m?.approval && !m.approval.resolved) || !!(m?.clarify && !m.clarify.resolved),
            )
            .map((m) => m!.conversationId),
        )
        const main = await db.conversations.get(mainThreadId(bot.id))
        // What the row previews: Main's last words, and where Main has none, its newest thread's —
        // a name says what a thread is called, not what the bot last said (ADR 0090). Main is not
        // one of those threads: it sits in the same table, so an empty Main would answer with its
        // own title, "Main", where the newest thread had words to show.
        const threads = chats.filter((chat) => chat.id !== main?.id)
        const newestThread = threads[0]
        return {
          bot,
          chats,
          local,
          main,
          preview: main ? await latestLine(main.id) : undefined,
          threadLine: newestThread ? await latestLine(newestThread.id) : undefined,
        }
      }),
    )
  }, [])
  return rows?.map(({ bot, chats, local, main, preview, threadLine }) => ({
    bot,
    latest: chats[0] && chats[0].id !== main?.id ? chats[0] : chats.find((c) => c.id !== main?.id),
    main,
    preview,
    threadLine,
    waiting: chats.filter((c) => local.has(c.id) || live[c.hermesSessionId]).length,
    unread: chats.some((chat) => isUnread(chat.updatedAt, marks[chat.id])),
  }))
}

/** The thread a bot's third pane reopens: the last one this device opened for that bot. */
export const lastThreadKey = (profileId: string) => `gots:last-thread:${profileId}`

/**
 * The thread each bot's third pane remembers — its lane memory, under `gots:last-thread:<bot>` on
 * this device alone — as a store a reader can subscribe to: a row is loaded from storage the first
 * time a reader asks for that bot, and every write tells each reader, which is what a close needs.
 * Storage stays the truth a read is answered from, so a row seeded before the app mounted is found.
 */
const remembered = createStore<Record<string, string | null>>({})

/** Writes a bot's row into the store, telling the readers only when it really moved. */
const writeRow = (profileId: string, thread: string | null) => {
  const all = remembered.get()
  if (profileId in all && all[profileId] === thread) return
  remembered.set({ ...all, [profileId]: thread })
}

/** What storage holds for a bot, or the row this page has where storage is blocked. */
function rememberedThread(profileId: string): string | null {
  try {
    return localStorage.getItem(lastThreadKey(profileId))
  } catch {
    // Storage blocked: the row this page holds still answers for as long as the page lives.
    return remembered.get()[profileId] ?? null
  }
}

/**
 * This device remembers `thread` for a bot from now on — `null` forgets it, which is what closing a
 * thread leaves — written through to storage and told to every reader.
 */
export function rememberThread(profileId: string, thread: string | null) {
  writeRow(profileId, thread)
  try {
    if (thread === null) localStorage.removeItem(lastThreadKey(profileId))
    else localStorage.setItem(lastThreadKey(profileId), thread)
  } catch {
    // As above: the row this page holds still answers for as long as the page lives.
  }
}

/**
 * The thread a bot's lane remembers, subscribing whatever draws it, and the one load of that bot's
 * row: the first ask takes storage's answer into the store, so a write on a close has the row it
 * changed to compare against.
 */
export function useRememberedThread(profileId: string | undefined): string | null {
  const all = remembered.use()
  const loaded = profileId ? profileId in all : true
  useEffect(() => {
    if (profileId && !loaded) writeRow(profileId, rememberedThread(profileId))
  }, [profileId, loaded])
  return profileId ? (all[profileId] ?? null) : null
}

/** What a bot's lane remembers and how many threads it has, read together for one answer. */
export interface LastOpened {
  /** The remembered thread, where it is still one of the bot's. */
  last?: string
  /** The id storage holds, whether or not the lane may reopen it. */
  stored: string | null
  /** How many threads the bot has at all. */
  threads: number
}

/**
 * What a bot's third pane holds while the address is Main: the thread this device opened last for
 * that bot, the thread storage holds even where the pane refuses it, and how many threads the bot
 * has at all. A remembered thread that is gone, or is one of another bot's, is no thread of this
 * pane's — Main alone is better than the wrong chat.
 */
export async function lastOpened(profileId: string): Promise<LastOpened> {
  const stored = rememberedThread(profileId)
  // The count and the remembered id are independent reads, so the pane waits for the slower alone.
  const [threads, found] = await Promise.all([
    db.conversations
      .where("[profileId+updatedAt]")
      .between([profileId, -Infinity], [profileId, Infinity])
      .filter((chat) => !chat.projectId && !chat.main)
      .count(),
    stored ? db.conversations.get(stored) : Promise.resolve(undefined),
  ])
  const last =
    found && found.profileId === profileId && !found.projectId && !found.main ? found.id : undefined
  return { last, stored, threads }
}

type LaneAnswer = LastOpened & { profileId: string }

/** What a chat's row says about who owns it: its bot, and whether it is a project session. */
type ChatOwner = Pick<Conversation, "profileId" | "projectId">

/**
 * What a bot's third pane is, as one answer: closed, so Main has the row's whole width; open at a
 * thread; open for a bot with no thread yet, where it says so; or not answered, while the bot's
 * thread list is still out — the lane then keeps the width and the content it had, so a switch
 * from one bot to another never flashes Main wide and back.
 */
export type BotLane =
  | { state: "closed" }
  | { state: "thread"; thread: string }
  | { state: "empty" }
  | { state: "unknown" }

/**
 * Everything the shell draws a bot's lane from, asked once: which bot it is for, what the lane is
 * and holds, and the two moves a later control makes without knowing the rule behind them.
 */
export interface BotPane {
  profileId: string
  lane: BotLane
  /**
   * Puts the lane away and forgets this bot's thread, so the next visit opens Main alone. Where the
   * address names that thread, its entry is replaced by this bot's Main as well — in the same act,
   * since a lane reading an address that still named the thread would hold it again. Whether there
   * is a thread to put away is the lane's own answer, so the caller reads `lane.state`.
   */
  close: () => void
  /** Puts back the thread this bot closed on this visit, where the lane is not already holding one. */
  reopen: () => void
}

/**
 * The lane from the thread the address is, this device's remembered one and the bot's count: the
 * address's thread wins, a list still out is no answer at all rather than no threads, a remembered
 * thread is the one the lane reopens, a bot with threads but none remembered is closed, and a bot
 * with none keeps the lane to say so.
 */
function laneOf(thread: string | undefined, answer: LastOpened | undefined): BotLane {
  if (thread) return { state: "thread", thread }
  if (!answer) return { state: "unknown" }
  if (answer.last) return { state: "thread", thread: answer.last }
  return answer.threads > 0 ? { state: "closed" } : { state: "empty" }
}

/**
 * With bot threads on, the sidebar, Main and a thread are three panes from `xl`, as a project stays
 * beside its sessions: the thread the address is, else the one this device opened last for that bot,
 * so looking at Main never costs the thread beside it. A bot with no thread yet keeps the pane and
 * says so in it, and a thread that is gone or belongs to another bot leaves it closed. Main is the
 * pane, so a thread picked there swaps in place on the right.
 *
 * What the pane holds beside Main is asked of the bot rather than of the address, so the address
 * moving between Main and a thread answers nothing again: the same chat stays drawn, and leaving a
 * thread leaves the one beside Main where it was.
 *
 * One answer for the shell, rather than a thread and an open flag it assembles again at every draw:
 * `lane` says which of the four the pane is, and what it holds, and `close` and `reopen` are the
 * moves a control makes without knowing the rule — a close forgets the thread, as the lane memory
 * and the next visit both need, and takes the address back to this bot's Main where it named it.
 */
export function useBotPane(enabled: boolean | undefined): BotPane | undefined {
  const large = useXLarge()
  const navigate = useNavigate()
  const { pathname, state } = useLocation()
  const chat = matchPath("/c/:id", pathname)?.params.id
  const main = chat ? mainThreadProfile(chat) : undefined
  const hint = (state as { bot?: string } | null)?.bot
  // A Main id names its own bot, so only a thread's id costs a row read. The query answers with
  // the address it ran for, so an answer for the one before it can't pass for this one's.
  const owner = useLiveQuery(async (): Promise<{ chat?: string; found?: ChatOwner | null }> => {
    if (!chat) return { found: null }
    if (main) return { chat, found: { profileId: main } }
    const found = await db.conversations.get(chat)
    return {
      chat,
      found: found ? { profileId: found.profileId, projectId: found.projectId } : null,
    }
  }, [chat, main])
  const found = owner && owner.chat === chat ? owner.found : undefined
  // The bot this pane is for, and the thread the address itself is, if it is one of the bot's.
  let profileId: string | undefined
  let thread: string | undefined
  if (main) {
    profileId = main
  } else if (found && !found.projectId) {
    profileId = found.profileId
    thread = chat
  } else if (found === undefined && hint) {
    // Still loading: go by what the link said.
    profileId = hint
    thread = chat
  }
  // Only a wide screen with the switch on has a third pane to fill, so only it pays for the count.
  // The address's own thread is the lane's answer already, so nothing is read while it names one:
  // the dep on `thread` is what asks for the count and the remembered id the moment the address is
  // Main again. The remembered row is a dep too, so a write that forgets a thread redraws the lane:
  // the store tells every reader, which the row in storage never did.
  const rememberedId = useRememberedThread(profileId)
  const kept = useLiveQuery(
    async (): Promise<LaneAnswer | undefined> =>
      !thread && large && enabled && profileId
        ? { profileId, ...(await lastOpened(profileId)) }
        : undefined,
    [large, enabled, profileId, thread, rememberedId],
  )
  // The answer this bot was last given, kept while an address naming a thread makes the read
  // needless: the lane must not fall back to `unknown` the moment the address leaves that thread,
  // or Main alone would be drawn before the bot is known to have a thread at all.
  const [answered, setAnswered] = useState<LaneAnswer | undefined>(undefined)
  // The answer names the bot it ran for, so one bot's answer can never pass for another's.
  const fresh = kept && kept.profileId === profileId ? kept : undefined
  if (fresh && fresh !== answered) setAnswered(fresh)
  const answer = fresh ?? (answered?.profileId === profileId ? answered : undefined)
  const lane = laneOf(thread, answer)
  const shown = lane.state === "thread" ? lane.thread : undefined
  // The thread this bot's lane closed on this visit, for `reopen`: one bot's at a time, so leaving
  // the bot forgets it.
  const closed = useRef<{ profileId: string; thread: string } | null>(null)
  useEffect(() => {
    if (closed.current && closed.current.profileId !== profileId) closed.current = null
  }, [profileId])
  const close = useCallback(() => {
    if (!profileId || !shown) return
    closed.current = { profileId, thread: shown }
    rememberThread(profileId, null)
    // The address moves in this same act, not on a later render: the lane reads the address's
    // thread before anything else, so forgetting one it still named would hold it again. Replacing
    // the entry it took — the way a sidebar row opens Main — keeps Back on the page before the
    // thread, and `quiet` is the state the shell skips its page slide for.
    if (thread === shown)
      navigate(`/c/${mainThreadId(profileId)}`, { replace: true, state: { quiet: true } })
  }, [profileId, shown, thread, navigate])
  const reopen = useCallback(() => {
    if (!profileId || lane.state === "thread") return
    const back = closed.current
    if (back?.profileId === profileId) rememberThread(profileId, back.thread)
  }, [profileId, lane.state])
  // Remembers the thread the address is, so the pane reopens it the next time the bot opens on Main.
  useEffect(() => {
    if (!profileId || !thread) return
    rememberThread(profileId, thread)
  }, [profileId, thread])

  if (!large || !enabled || !profileId) return undefined
  return { profileId, lane, close, reopen }
}
