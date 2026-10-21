import Dexie from "dexie"
import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { matchPath, useLocation } from "react-router"

import {
  db,
  getSettings,
  listEnabledProfiles,
  saveSettings,
  type BotSort,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { useXLarge } from "@/lib/media"
import { useWaiting, type WaitingReason } from "@/lib/waiting"

/** How many of a bot's newest threads its screen lists. */
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

export type ThreadState = "working" | "waiting" | "failed" | "idle"

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

/**
 * A bot's chats as threads, oldest started first so the newest sits at the bottom by the composer.
 * They keep the order they were started in, so a new message doesn't move a thread.
 */
export function useThreads(profileId: string | undefined): Thread[] | undefined {
  const live = useWaiting()
  const rows = useLiveQuery(async () => {
    if (!profileId) return []
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
    return rows.sort(
      (a, b) =>
        Number(Boolean(b.chat.main)) - Number(Boolean(a.chat.main)) ||
        a.chat.createdAt - b.chat.createdAt,
    )
  }, [profileId])

  return rows?.map(({ chat, opener, last, replies, streaming, failed, local }) => {
    const reason = local ?? live[chat.hermesSessionId]
    const state: ThreadState = reason
      ? "waiting"
      : streaming
        ? "working"
        : failed
          ? "failed"
          : "idle"
    return { chat, opener, last, replies, state, reason }
  })
}

export interface BotSummary {
  bot: Profile
  /** Its newest thread. */
  latest?: Conversation
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

const active = (summary: BotSummary) => summary.latest?.updatedAt ?? -Infinity
const byRecent = (a: BotSummary, b: BotSummary) => active(b) - active(a)
const byName = (a: BotSummary, b: BotSummary) =>
  a.bot.name.localeCompare(b.bot.name, undefined, { sensitivity: "base", numeric: true })

/**
 * `recent`: the newest thread first, bots without one last. `waiting`: the most threads waiting on
 * the user first, then recent. `name`: A to Z. `added`: the order the bots were linked in.
 */
export function sortBots(bots: BotSummary[], sort: BotSort): BotSummary[] {
  const sorted = [...bots]
  if (sort === "recent") sorted.sort((a, b) => byRecent(a, b) || byName(a, b))
  if (sort === "waiting")
    sorted.sort((a, b) => b.waiting - a.waiting || byRecent(a, b) || byName(a, b))
  if (sort === "name") sorted.sort(byName)
  return sorted
}

/** Every bot that's turned on, with its newest thread, for the sidebar, in the order linked. */
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
        return { bot, chats, local }
      }),
    )
  }, [])
  return rows?.map(({ bot, chats, local }) => ({
    bot,
    latest: chats[0],
    waiting: chats.filter((c) => local.has(c.id) || live[c.hermesSessionId]).length,
  }))
}

export interface BotPane {
  profileId: string
  /** The thread open beside the bot. */
  thread?: string
}

/**
 * With bot threads on, from `xl` a bot stays on screen while one of its threads is open, as a pane
 * to its left, the way a project does beside its sessions.
 */
export function useBotPane(enabled: boolean | undefined): BotPane | undefined {
  const large = useXLarge()
  const { pathname, state } = useLocation()
  const bot = matchPath("/b/:profileId", pathname)?.params.profileId
  const chat = matchPath("/c/:id", pathname)?.params.id
  const read = useLiveQuery(
    async () => ({ chat, found: chat ? ((await db.conversations.get(chat)) ?? null) : null }),
    [chat],
  )
  const hint = (state as { bot?: string } | null)?.bot
  if (!large || !enabled) return undefined
  if (bot) return { profileId: bot }
  if (!chat) return undefined
  const found = read?.chat === chat ? read.found : undefined
  if (found) return found.projectId ? undefined : { profileId: found.profileId, thread: chat }
  // Still loading: go by what the link said.
  if (found === undefined && hint) return { profileId: hint, thread: chat }
  return undefined
}
