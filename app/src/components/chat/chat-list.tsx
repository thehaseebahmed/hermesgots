/**
 * A bot's chats as a screen draws them: the bar the words are pinned under, the search where the
 * width puts it, the pill row, the rows themselves, the sentence a pill that keeps nothing says, and
 * the foot. A layout supplies what its bar says and which pills it holds; everything a second list
 * of the same chats must not be able to word or place differently — the press a row makes, the
 * search's one field, the order of the pills under it — is drawn here.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router"

import { BotChatRow } from "@/components/chat/bot-chat-row"
import { ChatHeader } from "@/components/chat/chat-header"
import { Chip, ChipRow } from "@/components/chip"
import { ItemGroup } from "@/components/item-list"
import { CHATS_SEARCH_FIELD_ID, ListFoot } from "@/components/list-foot"
import { SearchField } from "@/components/search-field"
import { botChatsPath } from "@/lib/bot-tabs"
import {
  CHAT_FILTERS,
  chatList,
  emptyOf,
  filterChatRows,
  type ChatClock,
  type ChatFilter,
  type ChatListRow,
} from "@/lib/chat-list"
import type { Profile } from "@/lib/db"
import { useXLarge } from "@/lib/media"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { useReadMarks } from "@/lib/read-marks"
import { useCanMakeRoom } from "@/lib/room"
import { beginChat, useNow } from "@/lib/threads"
import { useAllLiveRuns } from "@/lib/waiting"

/** A pill as a list holds it: the key it narrows by, its word, and the sentence it keeps nothing by. */
type ChatPill = (typeof CHAT_FILTERS)[number]

export function ChatList({
  bot,
  leading,
  title,
  subtitle,
  actions,
  pills,
  filter,
  onFilter,
  emptyFor,
  above,
  group,
  clock = "at",
  rows,
  selected,
  beside,
}: {
  bot: Profile
  /** The way back, where the screen leads with one: nothing here is the drawer's button. */
  leading?: ReactNode
  /** The bar's title, and the line under it, which are the screen's own words. */
  title: ReactNode
  subtitle?: ReactNode
  /** The control the bar trails, drawn by the screen that knows what it leads to. */
  actions?: ReactNode
  /** The pills this list narrows by, in the order they stand. */
  pills: readonly ChatPill[]
  /** The pill this list is drawn under, and the way the reader presses another. */
  filter: ChatFilter
  onFilter: (filter: ChatFilter) => void
  /** The sentence a pill that keeps nothing says — the pills' own words unless a screen words it. */
  emptyFor?: (filter: ChatFilter) => string
  /** What the screen draws above its rows, under the pills: the Side Chat List's Main. */
  above?: ReactNode
  /** The heading its rows stand under, in Code's group style; a list that has none draws them bare. */
  group?: string
  /**
   * The clock the rows are ordered by (`ChatClock`). A bot's list is as old as the last thing it was
   * told, so the flat layout takes the default; the Side Chat List asks for `latest`, since the chat
   * the reader has just written in is the one they are in.
   */
  clock?: ChatClock
  rows: ChatListRow[]
  selected?: string
  /** Whether the list stands beside a chat, which is what its rows' presses turn on. */
  beside?: boolean
}) {
  const navigate = useNavigate()
  const { back } = useNav()
  const { pathname } = useLocation()
  const marks = useReadMarks()
  // The press is the app's at its first entry — where this list stands when nothing opened it — and a
  // step back wherever something did, which `back()` answers itself.
  useEffect(() => setBackGuard(back()), [back])
  // The host's answer for each session, read once for the whole list: a run started on another device
  // is in flight here too, and only the poll can say so.
  const runs = useAllLiveRuns()
  // A room is made on a Host that advertises it, so the control is offered only where it can be used
  // — the same rule the legacy layout's Rooms section keeps (ADR 0129).
  const canMakeRoom = useCanMakeRoom()
  const now = useNow()
  // From the laptop width up the list has room for the field to stand in the bar, and the foot draws no
  // search at all there: one field, in the one place this width puts it (ADR 0145).
  const wide = useXLarge()
  const [query, setQuery] = useState("")
  // The pill narrows first and the search narrows what it kept, so the two emptinesses stay apart: a pill
  // that holds nothing says its own sentence, and a pill whose rows the words miss says the search's.
  const kept = useMemo(() => filterChatRows(rows, filter, marks), [rows, filter, marks])
  const shown = useMemo(() => chatList(kept, query, clock), [kept, query, clock])
  const empty =
    kept.length === 0
      ? (emptyFor ?? emptyOf)(filter)
      : shown.length === 0
        ? "No chats match."
        : null

  // A row opens its conversation over this list: a push from the list's own screen, so the list stays
  // the rung behind it. Where an item already stands beside the list the press replaces it instead —
  // two rows of one list are siblings, not steps, so back from the second is still the list.
  const replace = Boolean(beside) && pathname !== botChatsPath(bot.id)

  // A chat is made first and the address moved after it, so the screen that draws it is the one this
  // list opens. The entry says which bot it is for, so the shell keeps the list's lane while the new
  // row loads.
  const openChat = (to: string) => navigate(to, { replace, state: { bot: bot.id } })
  const start = async () => {
    const chat = await beginChat(bot.id)
    openChat(`/c/${chat.id}`)
  }

  /**
   * One row of the list. Every row here is a sibling of the list's: a chat, a room and a routine's
   * run alike open above it, and take the place of one already open beside it.
   */
  const draw = (row: ChatListRow) => (
    <li key={row.id}>
      <BotChatRow
        row={row}
        now={now}
        mark={marks[row.id]}
        selected={row.id === selected}
        profileId={bot.id}
        replace={replace}
        live={row.session ? runs[row.session] : undefined}
      />
    </li>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ChatHeader
        pinned
        // The screen's title names the bot itself — its face in a link, its name in the line under it
        // — so a second face here would say it twice.
        showBot={false}
        leading={leading}
        title={title}
        subtitle={subtitle}
        actions={actions}
        // The pills are pinned with the bar, in the slot the routines page fills with its state chips, so
        // a long list is filtered without scrolling back up to reach them (ADR 0145).
        below={
          <div className="flex flex-col gap-2">
            {wide && (
              <SearchField
                id={CHATS_SEARCH_FIELD_ID}
                value={query}
                onChange={setQuery}
                label="Search chats"
              />
            )}
            <ChipRow label="Filter chats">
              {pills.map(({ key, label }) => (
                <Chip key={key} active={filter === key} onClick={() => onFilter(key)}>
                  {label}
                </Chip>
              ))}
            </ChipRow>
          </div>
        }
      />

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {above}
        {empty && <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>}

        {shown.length > 0 &&
          (group ? (
            // One heading over the whole band, in Code's group style: the count it draws is the
            // rows this list is showing, and the group's own order is the list's.
            <ItemGroup group={{ key: "rows", label: group, items: shown }}>
              {shown.map(draw)}
            </ItemGroup>
          ) : (
            <ul className="flex flex-col">{shown.map(draw)}</ul>
          ))}
      </div>

      <ListFoot
        canMakeRoom={canMakeRoom}
        searchable={!wide}
        query={query}
        onQueryChange={setQuery}
        onNewChat={() => void start()}
        onNewRoom={() => navigate("/new-room", { state: { bot: bot.id } })}
      />
    </div>
  )
}
