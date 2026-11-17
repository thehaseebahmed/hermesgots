/**
 * The Side Chat List: a bot's chats and rooms, one press from Main, at the bot's list address
 * (`/b/<bot>/sidechats`).
 *
 * It is the shared list screen (`components/chat/chat-list.tsx`) with this screen's own words and
 * pills: the way back to Main leading, "Sidechats" over the bot and how many side chats it has, the
 * routines control trailing, and five pills — All, Unread, Archived, Chats and Rooms — because a
 * routine's run is the routines page's row, not a conversation of the bot's (G11). At the split width
 * the bot's **Main** stands above the rows with a Home glyph, since Main is the chat drawn beside
 * this list; at one pane there is no row for it, because this screen is what Main is not.
 *
 * The rows, the subtitle's count and Main's badge all read `sideChats(rows)`, less the archived ones
 * (`sideChats`), so the three cannot disagree about what a side chat is — and the rows are ordered by
 * when each chat last moved at all (`latest`), since a chat the reader has just written in is the one
 * they are in.
 */
import { useLiveQuery } from "dexie-react-hooks"
import { HouseIcon, RotateCcwClockIcon } from "lucide-react"
import { Link, Navigate, useParams } from "react-router"

import { BackButton } from "@/components/back-button"
import { ChatList } from "@/components/chat/chat-list"
import { ItemRow, pinnedLine } from "@/components/item-list"
import { buttonVariants } from "@/components/ui/button"
import { labelOf } from "@/lib/bot-name"
import { botMainPath, botRoutinesPath } from "@/lib/bot-tabs"
import { useBotRows } from "@/lib/chat-rows"
import {
  CHAT_FILTERS,
  MAIN_TITLE,
  chatAge,
  isChatFilter,
  sideChats,
  type ChatFilter,
  type ChatListRow,
} from "@/lib/chat-list"
import { chatFilterOf, saveChatFilter, type Profile } from "@/lib/db"
import { HEADER_BUTTON } from "@/lib/layout"
import { useSplit } from "@/lib/pane"
import { quietly } from "@/lib/report"
import { useNow } from "@/lib/threads"
import { useBotLabels } from "@/lib/use-bot-labels"
import { cn } from "@/lib/utils"

/**
 * The pills this list holds, in the order they stand: the flat list's, less Routines. No run is a side
 * chat, so a pill that keeps one would be a pill that draws what the screen has already left out.
 */
const PILLS = CHAT_FILTERS.filter((pill) => pill.key !== "routines")

/** The bot's Side Chat List, at its own address. */
export function SideChatsPage() {
  const { profileId } = useParams()
  if (!profileId) return <Navigate to="/" replace />
  return <SideChatsList profileId={profileId} />
}

/**
 * One bot's side chats: the shared list screen, drawn with this screen's bar and its Main above them.
 * `selected` is the chat the pane holds beside this list, which is what marks Main's row when Main is
 * the one open there.
 */
function SideChatsList({ profileId, selected }: { profileId: string; selected?: string }) {
  // The pill this bot's list keeps on this device, read as the key itself rather than the settings
  // row, for the reason the flat list reads it that way: a live query answering a fresh object would
  // re-render on every sync write. The key is the bot's own and shared with that list, so a stored
  // Routines — a pill this screen has not got — reads as All.
  const kept = useLiveQuery(async () => (await chatFilterOf(profileId)) ?? null, [profileId])
  const filter: ChatFilter = isChatFilter(kept) && kept !== "routines" ? kept : "all"
  const labels = useBotLabels()
  const answer = useBotRows(profileId, filter, "latest")
  const split = useSplit()
  const now = useNow()
  if (!answer) return null
  // A bot that is gone — deleted here or on another device — lands home rather than on a list it
  // cannot fill.
  if (!answer.bot) return <Navigate to="/" replace />
  const bot = answer.bot
  // Main is the bot's own screen and no side chat, so it stands above the rows rather than in them —
  // and only where there is a pane beside this list to draw it in.
  const main = answer.rows.find((row) => row.main)
  const sides = sideChats(answer.rows)
  // The count speaks for the bot's side chats, not for the pill on screen: an archived one is a side
  // chat the reader set aside, and the Archived pill is where it stands.
  const count = sides.filter((row) => !row.archived).length
  return (
    <ChatList
      bot={bot}
      leading={<BackButton label="Back to Main" to={botMainPath(bot.id)} floating />}
      title="Sidechats"
      subtitle={`${labelOf(labels, bot)} · ${count} ${count === 1 ? "side chat" : "side chats"}`}
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
      pills={PILLS}
      filter={filter}
      onFilter={(next) => void saveChatFilter(profileId, next).catch(quietly("Saving the filter"))}
      above={
        split && main ? <MainRow row={main} now={now} bot={bot} selected={selected} /> : undefined
      }
      group="Side Chats"
      clock="latest"
      rows={sides}
      selected={selected}
    />
  )
}

/**
 * A bot's Main above its side chats, at the split width only: the conversation the bot's own address
 * opens on, drawn as the row every list draws — marked with a Home glyph, since it is the bot's home
 * rather than one of its chats — and set off from the side chats under a separator.
 */
function MainRow({
  row,
  now,
  bot,
  selected,
}: {
  row: ChatListRow
  now: number
  bot: Profile
  /** The chat the pane holds, so the row says when it is the one drawn beside this list. */
  selected?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <ul data-slot="main-row" className="flex flex-col">
        <li>
          <ItemRow
            icon={<HouseIcon />}
            tone="muted"
            title={MAIN_TITLE}
            when={chatAge(row.at, now)}
            line={pinnedLine(row.pinned, row.needs ?? row.line)}
            warn={Boolean(row.needs)}
            selected={selected === row.id}
            link={{ to: `/c/${row.id}`, state: { bot: bot.id } }}
          />
        </li>
      </ul>
      <hr data-slot="main-separator" className="border-border/60" />
    </div>
  )
}
