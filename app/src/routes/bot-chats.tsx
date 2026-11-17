import { useLiveQuery } from "dexie-react-hooks"
import { MessageCircleIcon, RotateCcwClockIcon } from "lucide-react"
import { Link, Navigate, useParams } from "react-router"

import { Bot } from "@/components/bot"
import { ChatList } from "@/components/chat/chat-list"
import { EmptyPane } from "@/components/empty-pane"
import { buttonVariants } from "@/components/ui/button"
import { botPath, botRoutinesPath } from "@/lib/bot-tabs"
import { labelOf } from "@/lib/bot-name"
import { CHAT_FILTERS, isChatFilter, type ChatFilter } from "@/lib/chat-list"
import { useChatLayout } from "@/lib/chat-layout"
import { useBotRows } from "@/lib/chat-rows"
import { chatFilterOf, saveChatFilter } from "@/lib/db"
import { HEADER_BUTTON } from "@/lib/layout"
import { useBotChatsPane, type BotPane } from "@/lib/pane"
import { quietly } from "@/lib/report"
import { useBotLabels } from "@/lib/use-bot-labels"
import { cn } from "@/lib/utils"

/**
 * A bot's chats as the flat layout's one screen: every chat of the bot's, drawn flat. The bot's own
 * address lands on its Main, and its side chats have their own screen (`routes/side-chats.tsx`); this
 * is the list that layout draws, which the developer switch is what turns back on.
 */
export function BotChatsPage() {
  const { profileId } = useParams()
  const layout = useChatLayout()
  const enabled = layout === "flat"
  const pane = useBotChatsPane()
  // Nothing is drawn before the layout answers, and a device on the legacy layout — where a bot has
  // no screen — lands home rather than on a list it cannot fill.
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
      actions={
        <Link
          to={botRoutinesPath(bot.id)}
          aria-label="Routines"
          className={cn(
            buttonVariants({ variant: "outline", size: "icon-lg" }),
            HEADER_BUTTON,
            "shrink-0 text-muted-foreground",
          )}
        >
          <RotateCcwClockIcon />
        </Link>
      }
      pills={CHAT_FILTERS}
      filter={filter}
      onFilter={(next) => void saveChatFilter(profileId, next).catch(quietly("Saving the filter"))}
      rows={answer.rows}
      selected={selected}
      beside={beside}
    />
  )
}
