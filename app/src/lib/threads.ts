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
import { labelOf } from "@/lib/bot-name"
import { listsAsChat } from "@/lib/lists-as-chat"
import { byName } from "@/lib/compare"
import { useRoomNeeds } from "@/lib/room"
import { withDir, type Sort, type SortKey } from "@/lib/sort"
import { useStoredSort } from "@/lib/use-sort"
import { isUnread } from "@/lib/session-work"
import { useReadMarks } from "@/lib/read-marks"
import { useBotLabels } from "@/lib/use-bot-labels"
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
  /** What the row calls it: the bot's own name, and its host only against a namesake (ADR 0149). */
  label: string
  latest?: Conversation
  waiting: number
  /**
   * How many conversations of the bot's this device holds past its read mark: every chat its list
   * draws, and every room its roster seats — one conversation, one of the count (ADR 0110, ADR 0115).
   */
  unread: number
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
const byBotName = (a: BotSummary, b: BotSummary) => byName(a.label, b.label)

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
 * Every bot that's turned on, with its newest chat and how much of its list this device hasn't read,
 * for the sidebar, in the order linked. Its count reads the same conversations that list draws, never
 * a coding session's: a row that leads to the bot's screen must not say its news is in a screen it
 * cannot reach. The row's words are `stateLine`'s, and this is only what they count (ADR 0151).
 */
export function useBotSummaries(): BotSummary[] | undefined {
  const live = useWaiting()
  const marks = useReadMarks()
  // The rooms this device lists, by their membership: a room is nobody's chat, and it lists in every
  // bot its roster seats (ADR 0115), so it is one of the bot's conversations here as it is there.
  const rooms = useRoomNeeds()
  const rows = useLiveQuery(async () => {
    const bots = await listEnabledProfiles()
    return Promise.all(
      bots.map(async (bot) => {
        // Every chat the bot has, newest first: a chat older than a read bound is still a row of its
        // list, so it still counts (ADR 0136).
        const chats = await conversationsOf(bot.id).reverse().filter(listsAsChat).toArray()
        // Only a chat's newest reply can wait on the user, and a reply's read is what a row costs, so
        // only the newest `BOT_CHATS` are read — a bound on the reads, never on what the row counts.
        const newest = await Promise.all(
          chats.slice(0, BOT_CHATS).map((c) => newestMessage(c.id, isReply)),
        )
        const local = new Set(newest.filter((m) => waitsOnUser(m)).map((m) => m!.conversationId))
        return { bot, chats, local }
      }),
    )
  }, [])
  const labels = useBotLabels()
  return rows?.map(({ bot, chats, local }) => ({
    bot,
    label: labelOf(labels, bot),
    latest: chats[0],
    waiting: chats.filter((c) => local.has(c.id) || live[c.hermesSessionId]).length,
    // A chat this device has never opened holds no mark, so it counts for nothing, exactly as its row
    // draws no dot (ADR 0110). A room counts off its own record's clock and its own read mark, which
    // is the rule its row draws too (ADR 0115).
    unread:
      chats.filter((chat) => isUnread(chat.updatedAt, marks[chat.id])).length +
      (rooms ?? []).filter(
        (room) => room.seated.includes(bot.id) && isUnread(room.chat.updatedAt, marks[room.chat.id]),
      ).length,
  }))
}
