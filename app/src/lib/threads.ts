import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { matchPath, useLocation } from "react-router"

import { db, getSettings, listEnabledProfiles, type Conversation, type Profile } from "@/lib/db"
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

/** A bot's chats as threads, oldest first so the newest sits at the bottom by the composer. */
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
    const messages = await db.messages
      .where("conversationId")
      .anyOf(chats.map((c) => c.id))
      .toArray()
    return chats.reverse().map((chat) => {
      const own = messages
        .filter((m) => m.conversationId === chat.id)
        .sort((a, b) => a.createdAt - b.createdAt)
      const replies = own.filter((m) => m.role === "assistant")
      const latest = replies.at(-1)
      const local: WaitingReason | undefined =
        latest?.clarify && !latest.clarify.resolved
          ? { kind: "question", count: latest.clarify.questions.length || 1 }
          : latest?.approval && !latest.approval.resolved
            ? { kind: "approval", command: latest.approval.command }
            : undefined
      return {
        chat,
        opener: line(own.find((m) => m.role === "user")?.content),
        last: line(replies.findLast((m) => m.content.trim())?.content),
        replies: replies.length,
        streaming: latest?.status === "streaming",
        failed: latest?.status === "error",
        local,
      }
    })
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

/** Every bot that's turned on, with its newest thread, for the sidebar. */
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
        const open = await db.messages
          .where("conversationId")
          .anyOf(chats.map((c) => c.id))
          .filter(
            (m) => !!(m.approval && !m.approval.resolved) || !!(m.clarify && !m.clarify.resolved),
          )
          .toArray()
        return { bot, chats, local: new Set(open.map((m) => m.conversationId)) }
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
