import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  conversationsOf,
  createConversation,
  isReply,
  listEnabledProfiles,
  newestMessage,
  type BotSort,
  type Conversation,
  type ModelChoice,
  type Profile,
} from "@/lib/db"
import { listsAsChat } from "@/lib/lists-as-chat"
import { byName } from "@/lib/compare"
import { plainLine } from "@/lib/words"
import { withDir, type Sort, type SortKey } from "@/lib/sort"
import { useStoredSort } from "@/lib/use-sort"
import { isUnread } from "@/lib/session-work"
import { useReadMarks } from "@/lib/read-marks"
import { useWaiting } from "@/lib/waiting"
import { BOT_CHATS, waitsOnUser } from "@/lib/chat-list"

/**
 * The chat a new chat opens: a plain chat of the bot's, since a bot's screen is the list of its chats
 *. Both layouts ask this, so a new chat is the same record either way.
 *
 * `modelChoice` is the pick a blank surface was holding, which rides into the chat it makes, where it
 * is the chat's own.
 */
export async function beginChat(profileId: string, message: { modelChoice?: ModelChoice } = {}) {
  return createConversation(profileId, { modelChoice: message.modelChoice })
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

export interface BotSummary {
  bot: Profile
  latest?: Conversation
  /** The newest chat's latest message, cut to a line. */
  preview?: string
  waiting: number
  /** A chat this device holds past its read mark, and never a coding session's (ADR 0110). */
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

const active = (summary: BotSummary) => summary.latest?.updatedAt ?? -Infinity
const byRecent = (a: BotSummary, b: BotSummary) => active(a) - active(b)
const byAdded = (a: BotSummary, b: BotSummary) => a.bot.createdAt - b.bot.createdAt
const byBotName = (a: BotSummary, b: BotSummary) => byName(a.bot.name, b.bot.name)

/**
 * `recent`: the newest chat first, bots without one last. `waiting`: the most chats waiting on the
 * user first, then recent. `name`: A to Z. `added`: the order the bots were linked in. The arrow
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
 * Every bot that's turned on, with its newest chat and the line it last said, for the sidebar, in the
 * order linked. Its dot reads the same chats, never a coding session's: a row that leads to the bot's
 * screen must not say its news is in a screen it cannot reach.
 */
export function useBotSummaries(): BotSummary[] | undefined {
  const live = useWaiting()
  const marks = useReadMarks()
  const rows = useLiveQuery(async () => {
    const bots = await listEnabledProfiles()
    return Promise.all(
      bots.map(async (bot) => {
        const chats = await conversationsOf(bot.id)
          .reverse()
          .filter(listsAsChat)
          .limit(BOT_CHATS)
          .toArray()
        // Only a chat's newest reply can wait on the user, so only that one is read, and the row the
        // bot previews is read beside it rather than after the batch — unless that row is a
        // routine's, whose line is on its record and which holds no message here at all.
        const newestChat = chats[0]
        const [newest, words] = await Promise.all([
          Promise.all(chats.map((c) => newestMessage(c.id, isReply))),
          newestChat && !newestChat.routine ? newestMessage(newestChat.id) : undefined,
        ])
        const local = new Set(newest.filter((m) => waitsOnUser(m)).map((m) => m!.conversationId))
        // What the row previews: what the bot's newest chat last said — a run says it on its own
        // record, as the bot's list draws it — and a chat with no words of its own answering with
        // its name rather than nothing at all (ADR 0090).
        const preview = newestChat?.routine
          ? newestChat.line
          : words
            ? plainLine(words.content)
            : undefined
        return { bot, chats, local, preview }
      }),
    )
  }, [])
  return rows?.map(({ bot, chats, local, preview }) => ({
    bot,
    latest: chats[0],
    preview,
    waiting: chats.filter((c) => local.has(c.id) || live[c.hermesSessionId]).length,
    unread: chats.some((chat) => isUnread(chat.updatedAt, marks[chat.id])),
  }))
}
