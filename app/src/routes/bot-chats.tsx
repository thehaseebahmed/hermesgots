import { MessageCircleIcon } from "lucide-react"
import { Navigate, useParams } from "react-router"

import { BotTitle } from "@/components/chat/bot-title"
import { ChatList } from "@/components/chat/chat-list"
import { RoutinesButton } from "@/components/chat/routines-button"
import { EmptyPane } from "@/components/empty-pane"
import { botMainPath } from "@/lib/bot-tabs"
import { labelOf } from "@/lib/bot-name"
import { CHAT_FILTERS } from "@/lib/chat-list"
import { useChatLayout } from "@/lib/chat-layout"
import { useBotRows } from "@/lib/chat-rows"
import { saveChatFilter } from "@/lib/db"
import { useBotChatsPane, type BotPane } from "@/lib/pane"
import { quietly } from "@/lib/report"
import { useChatFilter } from "@/lib/use-chat-filter"
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
  const filter = useChatFilter(profileId, CHAT_FILTERS)
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
      title={<BotTitle botId={bot.id} face={bot.botId} label={labelOf(labels, bot)} />}
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
