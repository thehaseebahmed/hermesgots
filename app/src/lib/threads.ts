import Dexie from "dexie"
import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { matchPath, useLocation } from "react-router"

import {
  db,
  getSettings,
  listEnabledProfiles,
  mainThreadId,
  mainThreadProfile,
  saveSettings,
  type BotSort,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { useXLarge } from "@/lib/media"
import { byName } from "@/lib/compare"
import { threadState, type ThreadState } from "@/lib/session-work"
import { useLiveSubagents, useWaiting, type WaitingReason } from "@/lib/waiting"

/** How many of a bot's newest threads its screen lists, and Main draws as cards. */
const THREADS = 50

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

const line = (text?: string) => text?.replace(/\s+/g, " ").trim() || undefined

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
          opener: line(opener?.content),
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

  // One list per answer: a fresh array each render would invalidate every memo a chat composes over
  // these threads (its cards, its flow, what moved), for a list that didn't change.
  return useMemo(() => {
    if (!answer || answer.profileId !== profileId) return undefined
    return answer.rows.map(({ chat, opener, last, replies, streaming, failed, local }) => {
      const reason = local ?? live[chat.hermesSessionId]
      const state = threadState({
        waiting: Boolean(reason),
        streaming,
        failed,
        subagents: subagents[chat.hermesSessionId],
      })
      return { chat, opener, last, replies, state, reason }
    })
  }, [answer, profileId, live, subagents])
}

export interface BotSummary {
  bot: Profile
  /** Its newest thread. */
  latest?: Conversation
  /** Its Main thread, once this device has opened it. */
  main?: Conversation
  preview?: string
  /** Threads waiting on the user. */
  waiting: number
}

export const BOT_SORTS: Record<BotSort, string> = {
  recent: "Recent",
  waiting: "Waiting",
  name: "Name",
  added: "Added",
}

/** The sidebar's bot order, kept on this device. */
export function useBotSort(): [BotSort, (sort: BotSort) => void] {
  const sort = useLiveQuery(async () => (await getSettings()).botSort, []) ?? "recent"
  return [sort, (botSort) => void saveSettings({ botSort })]
}

const active = (summary: BotSummary) => (summary.main ?? summary.latest)?.updatedAt ?? -Infinity
const byRecent = (a: BotSummary, b: BotSummary) => active(b) - active(a)
const byBotName = (a: BotSummary, b: BotSummary) => byName(a.bot.name, b.bot.name)

/**
 * `recent`: the newest thread first, bots without one last. `waiting`: the most threads waiting on
 * the user first, then recent. `name`: A to Z. `added`: the order the bots were linked in.
 */
export function sortBots(bots: BotSummary[], sort: BotSort): BotSummary[] {
  const sorted = [...bots]
  if (sort === "recent") sorted.sort((a, b) => byRecent(a, b) || byBotName(a, b))
  if (sort === "waiting")
    sorted.sort((a, b) => b.waiting - a.waiting || byRecent(a, b) || byBotName(a, b))
  if (sort === "name") sorted.sort(byBotName)
  return sorted
}

/**
 * Every bot that's turned on, with its newest thread and — once this device has opened it — its
 * Main thread and the line it last said, for the sidebar, in the order linked.
 */
export function useBotSummaries(): BotSummary[] | undefined {
  const live = useWaiting()
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
        return { bot, chats, local, main, preview: main ? await latestLine(main.id) : undefined }
      }),
    )
  }, [])
  return rows?.map(({ bot, chats, local, main, preview }) => ({
    bot,
    latest: chats[0],
    main,
    preview,
    waiting: chats.filter((c) => local.has(c.id) || live[c.hermesSessionId]).length,
  }))
}

/** The thread a bot's third pane reopens: the last one this device opened for that bot. */
export const lastThreadKey = (profileId: string) => `memento:last-thread:${profileId}`

/**
 * What a bot's third pane holds while the address is Main: the thread this device opened last for
 * that bot, the thread storage holds even where the pane refuses it, and how many threads the bot
 * has at all. A remembered thread that is gone, or is one of another bot's, is no thread of this
 * pane's — Main alone is better than the wrong chat.
 */
export async function lastOpened(profileId: string) {
  const threads = await db.conversations
    .where("[profileId+updatedAt]")
    .between([profileId, -Infinity], [profileId, Infinity])
    .filter((chat) => !chat.projectId && !chat.main)
    .count()
  let stored: string | null = null
  let last: string | undefined
  try {
    stored = localStorage.getItem(lastThreadKey(profileId))
    const found = stored ? await db.conversations.get(stored) : undefined
    if (found && found.profileId === profileId && !found.projectId && !found.main) last = found.id
  } catch {
    // Storage can be blocked; the pane then has Main alone.
  }
  return { last, stored, threads }
}

/** What a chat's row says about who owns it: its bot, and whether it is a project session. */
type ChatOwner = Pick<Conversation, "profileId" | "projectId">

export interface BotPane {
  profileId: string
  /** The thread the address itself is, when it is one of the bot's threads. */
  thread?: string
  /** The thread the third pane reopens while the address is Main: this bot's last one opened here. */
  last?: string
  /** Whether the bot has a thread at all, since a bot with none gets the pane's empty state. */
  threads: boolean
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
 */
export function useBotPane(enabled: boolean | undefined): BotPane | undefined {
  const large = useXLarge()
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
  // The address is a dependency so the read follows the thread this page just opened — the storage
  // it comes from isn't reactive — and Dexie keeps the answer it has until the new one lands, so
  // the pane never empties between the two.
  const kept = useLiveQuery(
    async () =>
      large && enabled && profileId ? { profileId, ...(await lastOpened(profileId)) } : undefined,
    [large, enabled, profileId, thread],
  )
  // The answer names the bot it ran for, so one bot's answer can never pass for another's.
  const answer = kept && kept.profileId === profileId ? kept : undefined
  // Remembers the thread the address is, so the pane reopens it the next time the bot opens on Main.
  useEffect(() => {
    if (!profileId || !thread) return
    try {
      localStorage.setItem(lastThreadKey(profileId), thread)
    } catch {
      // As above: the pane opens on Main alone.
    }
  }, [profileId, thread])

  if (!large || !enabled || !profileId) return undefined
  if (thread) return { profileId, thread, threads: true }
  // Nothing remembered yet reads as no thread to show, never as a bot without threads.
  return { profileId, last: answer?.last, threads: answer?.threads !== 0 }
}
