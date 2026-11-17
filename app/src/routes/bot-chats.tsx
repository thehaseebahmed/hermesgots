import { useLiveQuery } from "dexie-react-hooks"
import { MessageCircleIcon } from "lucide-react"
import { Link, Navigate, useParams } from "react-router"

import { Bot } from "@/components/bot"
import { ChatList } from "@/components/chat/chat-list"
import { RoutinesButton } from "@/components/chat/routines-button"
import { EmptyPane } from "@/components/empty-pane"
import { botMainPath, botPath } from "@/lib/bot-tabs"
import { labelOf } from "@/lib/bot-name"
import { CHAT_FILTERS, isChatFilter, type ChatFilter } from "@/lib/chat-list"
import { useChatLayout } from "@/lib/chat-layout"
import { useBotRows } from "@/lib/chat-rows"
import { chatFilterOf, saveChatFilter } from "@/lib/db"
import { useBotChatsPane, type BotPane } from "@/lib/pane"
import { quietly } from "@/lib/report"
import { useBotLabels } from "@/lib/use-bot-labels"

/**
 * A bot's chats as the flat layout's one screen: every chat of the bot's, drawn flat, with its
 * routines' deliveries among the rows — the list the developer switch turns back on (ADR 0162). The
 * bot's own address is where this list stands, as it was before a bot opened on a Main of its own, so
 * the switch's reader lands exactly where the old layout left them.
 */
export function BotChatsPage() {
  const { profileId } = useParams()
  const layout = useChatLayout()
  const enabled = layout === "flat"
  const pane = useBotChatsPane()
  // Nothing is drawn before the layout answers, and a device drawing the new UX — where this list has
  // no address — lands home rather than on a list it cannot fill.
  if (layout === undefined) return null
  if (!enabled || !profileId) return <Navigate to="/" replace />
  if (pane) return <NoChatOpen />
  return <BotChatsList profileId={profileId} />
}

export function BotChatsPane({ pane }: { pane: BotPane }) {
  return <BotChatsList profileId={pane.profileId} selected={pane.selected} beside />
}

/**
 * The item lane with nothing open in it, at the two-pane width: a chat's mark over the words saying
 * so. The single-pane width has no lane to fill — the list is the screen there — so nothing of this is
 * drawn.
 */
function NoChatOpen() {
  return (
    <EmptyPane icon={MessageCircleIcon} slot="bot-chats-empty">
      No chat selected
    </EmptyPane>
  )
}

/**
 * A bot's chats, drawn by the shared list screen with this layout's own bar: the bot's face and its
 * name are the way to its settings, the routines control trails them, and the list holds every pill.
 * The rows — the bot's chats and the rooms its roster seats — are `useBotRows`'s one list.
 */
function BotChatsList({
  profileId,
  selected,
  beside,
}: {
  profileId: string
  /** The chat drawn open beside this list, which is the pane's to name and no screen's. */
  selected?: string
  beside?: boolean
}) {
  // The pill this bot's list keeps on this device, read as the key itself rather than the settings
  // row: a live query that answered a fresh object would re-render the list on every sync write (the
  // reason `useStoredSort` records), and anything that is not one of the pills reads as All. It is
  // read here rather than in the list because the tail read is what the pill widens.
  const keptKey = useLiveQuery(async () => (await chatFilterOf(profileId)) ?? null, [profileId])
  const filter: ChatFilter = isChatFilter(keptKey) ? keptKey : "all"
  // The bar names the bot as the sidebar's row does (ADR 0149).
  const labels = useBotLabels()
  const answer = useBotRows(profileId, filter)
  if (!answer) return null
  // A bot that is gone — deleted here or on another device — lands home rather than on a list it
  // cannot fill.
  if (!answer.bot) return <Navigate to="/" replace />
  const bot = answer.bot
  return (
    <ChatList
      bot={bot}
      title={
        <Link
          to={botPath(bot.id)}
          className="-ml-2 flex min-h-11 min-w-0 items-center gap-2 rounded-full px-2 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden className="shrink-0">
            <Bot id={bot.botId} className="size-9" />
          </span>
          <span className="truncate">{labelOf(labels, bot)}</span>
        </Link>
      }
      actions={<RoutinesButton profileId={bot.id} />}
      pills={CHAT_FILTERS}
      filter={filter}
      onFilter={(next) => void saveChatFilter(profileId, next).catch(quietly("Saving the filter"))}
      listPath={botMainPath(bot.id)}
      rows={answer.rows}
      selected={selected}
      beside={beside}
    />
  )
}
