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
 * At the split width the list is the lane and this address draws Main in the item lane beside it — the
 * two panes hold one pair of screens, the same pair a picked side chat opens beside (`useBotChatsPane`
 * names the bot's one screen for all three addresses, so moving between them replays no transition).
 * A bot whose Main this device does not hold keeps the list standing whole rather than beside a blank.
 *
 * The rows, the subtitle's count and Main's badge all read `sideChats(rows)`, less the archived ones
 * (`shownSideChats`), so the three cannot disagree about what a side chat is — and the list orders its
 * rows by when each chat last moved at all (`clock="latest"`), since a chat the reader has just written
 * in is the one they are in. The order is this list's: the rows arrive unsorted.
 */
import { useCallback } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { HouseIcon } from "lucide-react"
import { Navigate, useParams } from "react-router"

import { BackButton } from "@/components/back-button"
import { BotChatRow } from "@/components/chat/bot-chat-row"
import { ChatList } from "@/components/chat/chat-list"
import { RoutinesButton } from "@/components/chat/routines-button"
import { labelOf } from "@/lib/bot-name"
import { botChatsPath, botMainPath } from "@/lib/bot-tabs"
import { useBotRows } from "@/lib/chat-rows"
import {
  CHAT_FILTERS,
  isChatFilter,
  shownSideChats,
  sideChats,
  type ChatFilter,
  type ChatListRow,
} from "@/lib/chat-list"
import { chatFilterOf, saveChatFilter, type Profile } from "@/lib/db"
import { useNav } from "@/lib/nav"
import { useBotChatsPane, useSplit, type BotPane } from "@/lib/pane"
import { useReadMarks } from "@/lib/read-marks"
import { quietly } from "@/lib/report"
import { useNow } from "@/lib/threads"
import { useBotLabels } from "@/lib/use-bot-labels"
import { useAllLiveRuns } from "@/lib/waiting"
import { ChatPage } from "@/routes/chat"

/**
 * The pills this list holds, in the order they stand: the flat list's, less Routines. No run is a side
 * chat, so a pill that keeps one would be a pill that draws what the screen has already left out.
 */
const PILLS = CHAT_FILTERS.filter((pill) => pill.key !== "routines")

/** The bot's Side Chat List, at its own address. */
export function SideChatsPage() {
  const { profileId } = useParams()
  // What the shell has beside this list, where it has room for a second pane: at the split width that
  // is the bot's **Main**, which is the chat this address draws — the list stands in the lane — so the
  // pair hold the same screen whether the reader is on Main, on this list or on a side chat of it.
  const pane = useBotChatsPane()
  if (!profileId) return <Navigate to="/" replace />
  if (pane?.open && pane.selected) return <ChatPage slot="main" id={pane.selected} />
  return <SideChatsList profileId={profileId} />
}

/**
 * This bot's Side Chat List as the lane beside the chat it opened: the same screen the address draws
 * where there is no room for a second pane, with the row the pane holds marked.
 */
export function SideChatsPane({ pane }: { pane: BotPane }) {
  return <SideChatsList profileId={pane.profileId} selected={pane.selected} beside />
}

/**
 * One bot's side chats: the shared list screen, drawn with this screen's bar and its Main above them.
 * `selected` is the chat the pane holds beside this list, which is what marks Main's row when Main is
 * the one open there.
 */
function SideChatsList({
  profileId,
  selected,
  beside,
}: {
  profileId: string
  /** The chat the pane holds beside this list, which is what marks its row. */
  selected?: string
  /** Whether this list stands beside the chat it opened, which is what its rows' presses turn on. */
  beside?: boolean
}) {
  // The pill this bot's list keeps on this device, read as the key itself rather than the settings
  // row, for the reason the flat list reads it that way: a live query answering a fresh object would
  // re-render on every sync write. The key is the bot's own and shared with that list, so a stored
  // Routines — a pill this screen has not got — reads as All.
  const kept = useLiveQuery(async () => (await chatFilterOf(profileId)) ?? null, [profileId])
  const filter: ChatFilter = isChatFilter(kept) && kept !== "routines" ? kept : "all"
  const labels = useBotLabels()
  const answer = useBotRows(profileId, filter)
  const split = useSplit()
  const now = useNow()
  const { up } = useNav()
  // The one move the bar's control and the platform's press both make: a step up to the bot's Main,
  // which is the bot's entry — not a second copy of Main pushed over a list that came from it. Opened
  // cold this list stands at the app's first entry, where the same step puts Main in its place.
  const ontoMain = useCallback(() => {
    up(botMainPath(profileId))
    return true
  }, [profileId, up])
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
  // chat the reader set aside, and the Archived pill is where it stands. It is the one rule — Main's
  // control is badged by the same `shownSideChats` — so the two cannot disagree.
  const count = shownSideChats(answer.rows).length
  return (
    <ChatList
      bot={bot}
      leading={<BackButton label="Back to Main" onClick={ontoMain} floating />}
      title="Sidechats"
      subtitle={`${labelOf(labels, bot)} · ${count} ${count === 1 ? "side chat" : "side chats"}`}
      actions={<RoutinesButton profileId={bot.id} />}
      pills={PILLS}
      filter={filter}
      onFilter={(next) => void saveChatFilter(profileId, next).catch(quietly("Saving the filter"))}
      listPath={botChatsPath(bot.id)}
      onBack={!beside && main ? ontoMain : undefined}
      above={
        split && main ? (
          <MainRow
            row={main}
            now={now}
            bot={bot}
            replace={Boolean(beside)}
            selected={selected}
          />
        ) : undefined
      }
      group="Side Chats"
      clock="latest"
      rows={sides}
      selected={selected}
      beside={beside}
    />
  )
}

/**
 * A bot's Main above its side chats, at the split width only: the conversation the bot's own address
 * opens on, drawn as the row every list draws — marked with a Home glyph, since it is the bot's home
 * rather than one of its chats — and set off from the side chats under a separator.
 *
 * It is `BotChatRow`, the row the side chats under it are, with the glyph for its icon: a hand-built
 * row here lost the unread dot, the spinner and the `replace` its neighbours have, and read `Main`
 * where the record says `Bot Chat`. Its marks are its own reads — this device's read mark and the
 * host's live run — because it stands outside the list that draws the others.
 */
function MainRow({
  row,
  now,
  bot,
  replace,
  selected,
}: {
  row: ChatListRow
  now: number
  bot: Profile
  /** Whether the press takes the place of the chat the pane holds, as every row beside a list does. */
  replace?: boolean
  /** The chat the pane holds, so the row says when it is the one drawn beside this list. */
  selected?: string
}) {
  const mark = useReadMarks()[row.id]
  const runs = useAllLiveRuns()
  return (
    <div className="flex flex-col gap-2">
      <ul data-slot="main-row" className="flex flex-col">
        <li>
          <BotChatRow
            row={row}
            now={now}
            mark={mark}
            selected={selected === row.id}
            profileId={bot.id}
            replace={replace}
            live={row.session ? runs[row.session] : undefined}
            icon={<HouseIcon />}
          />
        </li>
      </ul>
      <hr data-slot="main-separator" className="border-border/60" />
    </div>
  )
}
