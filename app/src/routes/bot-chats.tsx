import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CircleAlertIcon, MessageCircleIcon, RotateCcwClockIcon } from "lucide-react"
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
} from "react-router"

import { Bot } from "@/components/bot"
import { BackButton } from "@/components/back-button"
import { ChatHeader } from "@/components/chat/chat-header"
import { Chip, ChipRow } from "@/components/chip"
import { ItemRow, pinnedLine } from "@/components/item-list"
import { SearchField } from "@/components/search-field"
import { CHATS_SEARCH_FIELD_ID, ListFoot } from "@/components/list-foot"
import { RoomFaces } from "@/components/room/room-faces"
import { Spinner } from "@/components/ui/spinner"
import { buttonVariants } from "@/components/ui/button"
import { botPath, botRoutinesPath } from "@/lib/bot-tabs"
import {
  BOT_CHATS,
  CHAT_FILTERS,
  chatAge,
  chatList,
  chatRowOf,
  emptyOf,
  filterChatRows,
  isChatFilter,
  type ChatFilter,
  type ChatListRow,
} from "@/lib/chat-list"
import {
  conversationsOf,
  db,
  getSettings,
  isReply,
  newestMessage,
  saveSettings,
  type Profile,
} from "@/lib/db"
import type { LiveRunStatus } from "@/lib/hermes"
import { HEADER_BUTTON } from "@/lib/layout"
import { landingChat } from "@/lib/last-chat"
import { useXLarge } from "@/lib/media"
import { listsAsChat } from "@/lib/lists-as-chat"
import { setBackGuard } from "@/lib/native"
import { BACK_ON_LIST, depth, openedChat, useNav } from "@/lib/nav"
import { useBotChatsPane, type BotPane } from "@/lib/pane"
import { useReadMarks } from "@/lib/read-marks"
import { quietly } from "@/lib/report"
import { useCanMakeRoom, useRoomNeeds } from "@/lib/room"
import { roomRowOf } from "@/lib/rooms"
import { useAllLiveRuns } from "@/lib/waiting"
import { isUnread, runInFlight } from "@/lib/session-work"
import { useLegacyChat } from "@/lib/legacy-chat"
import { beginChat, useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"

export function BotChatsPage() {
  const { profileId } = useParams()
  const legacy = useLegacyChat()
  const enabled = legacy === false
  const pane = useBotChatsPane(enabled)
  const place = useListPlace()
  const landing = useLanding(profileId, enabled, place.landed)
  // Nothing is drawn before the layout answers, and a device on the legacy layout — where a bot has
  // no screen — lands home rather than on a list it cannot fill.
  if (legacy === undefined) return null
  if (!enabled || !profileId) return <Navigate to="/" replace />
  // The chat the address opens is on its way, so neither the list it is leaving nor an empty pane is
  // drawn for a frame.
  if (landing) return null
  if (pane) return <NoChatOpen />
  return <BotChatsList profileId={profileId} selected={place.open} pushed={!place.root} />
}

function useListPlace() {
  const type = useNavigationType()
  const state = useLocation().state
  const listed = Boolean((state as typeof BACK_ON_LIST | null)?.listed)
  const root = depth() === 0
  // The landing fires at the app's entry, arrived at forwards, with nobody having asked for the
  // list: a step back onto it arrives as a `POP`, and a list a chat pushed or a screen stepped back
  // onto is either not the entry or carries the marker. Each draws the list rather than a chat.
  return { root, open: openedChat(state), landed: root && type !== "POP" && !listed }
}

function useLanding(profileId: string | undefined, enabled: boolean | undefined, landed: boolean) {
  const navigate = useNavigate()
  const answer = useLiveQuery(
    async () =>
      profileId && enabled && landed
        ? { profileId, chat: (await landingChat(profileId)) ?? null }
        : undefined,
    [profileId, enabled, landed],
  )
  const chat = answer && answer.profileId === profileId ? answer.chat : undefined
  const opens = landed && Boolean(chat)
  // One landing per visit: a second effect (a strict-mode double run) opens nothing again.
  const opened = useRef(false)
  useEffect(() => {
    if (!opens || opened.current) return
    opened.current = true
    navigate(`/c/${chat}`, { replace: true, state: { bot: profileId } })
  }, [opens, chat, profileId, navigate])
  return landed && (chat === undefined || opens)
}

export function BotChatsPane({ pane }: { pane: BotPane }) {
  return <BotChatsList profileId={pane.profileId} selected={pane.selected} />
}

function NoChatOpen() {
  return (
    <div
      data-slot="bot-chats-empty"
      className="flex min-h-0 flex-1 items-center justify-center px-6 text-center"
    >
      <p className="text-sm text-muted-foreground">No chat open</p>
    </div>
  )
}

/**
 * A bot's chats, each with the one read of its newest message that a row's line and time come from,
 * and the rooms it is a participant of: one list, one order.
 */
function BotChatsList({
  profileId,
  selected,
  pushed,
}: {
  profileId: string
  /** The chat this list stands over: beside it in the pane, or under it where it was pushed. */
  selected?: string
  /** Whether this list is a screen pushed over the chat it covers rather than the app's own entry. */
  pushed?: boolean
}) {

  // The rooms this device lists, read by their membership: a room belongs to its Host and lists in
  // every bot its roster seats, whatever bot carried the record here (ADR 0115).
  const rooms = useRoomNeeds()
  // The answer names the address it ran for, so one bot's answer can never pass for another's.
  const answer = useLiveQuery(async () => {
    const bot = await db.profiles.get(profileId)
    if (!bot) return { profileId, bot: null, rows: [] }
    // Every chat the bot has, newest first: a chat older than any bound is still a row of this list,
    // since a bound is not something a reader can see (ADR 0136).
    const chats = await conversationsOf(profileId).reverse().filter(listsAsChat).toArray()
    // What a row costs is the read of its newest message, never its record, so the tails are read
    // for the newest `BOT_CHATS` chats and every pinned one — a pin is the reader's own word that
    // the chat matters, wherever its clock puts it — and a row past that bound draws its title and
    // age from the record alone.
    const tailed = new Set(
      [...chats.slice(0, BOT_CHATS), ...chats.filter((chat) => chat.pinned)].map((chat) => chat.id),
    )
    const rows = await Promise.all(
      // A routine's row reads its line and time off the record, so its tail isn't asked for at all.
      chats.map(async (chat) => {
        if (chat.routine || !tailed.has(chat.id)) return chatRowOf(chat)
        const newest = await newestMessage(chat.id)
        // The row says what the bot last said, and a question or an approval sits on a reply: a read
        // of the newest message that already is one answers both, and one that is the reader's own
        // asks for the reply above it.
        const reply = !newest || isReply(newest) ? newest : await newestMessage(chat.id, isReply)
        return chatRowOf(chat, newest, reply)
      }),
    )
    return { profileId, bot, rows }
  }, [profileId])
  const fresh = answer && answer.profileId === profileId ? answer : undefined
  if (!fresh) return null
  // A bot that is gone — deleted here or on another device — lands home rather than on a list it
  // cannot fill.
  if (!fresh.bot) return <Navigate to="/" replace />
  const seated = (rooms ?? [])
    .filter((room) => room.seated.includes(profileId))
    .map((room) => roomRowOf(room.chat, room.faces, room.said))
  return <ChatList bot={fresh.bot} rows={[...fresh.rows, ...seated]} selected={selected} pushed={pushed} />
}

function ChatList({
  bot,
  rows,
  selected,
  pushed,
}: {
  bot: Profile
  rows: ChatListRow[]
  selected?: string
  pushed?: boolean
}) {
  const navigate = useNavigate()
  const { back } = useNav()
  // What stands behind this screen, as far as the entry that opened it says: a chat's own control is
  // the only thing that pushes a list, but a typed or restored address can land it on any entry.
  const backToChat = Boolean(selected)
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
  // The pill this device keeps, read as the key itself rather than the settings row: a live query that
  // answered a fresh object would re-render the list on every sync write (the reason `useStoredSort`
  // records), and a key an older build wrote is no pill at all.
  const keptKey = useLiveQuery(async () => (await getSettings()).chatFilter ?? null, [])
  const filter: ChatFilter = isChatFilter(keptKey) ? keptKey : "all"
  const chooseFilter = (next: ChatFilter) =>
    void saveSettings({ chatFilter: next }).catch(quietly("Saving the filter"))
  // The pill narrows first and the search narrows what it kept, so the two emptinesses stay apart: a pill
  // that holds nothing says its own sentence, and a pill whose rows the words miss says the search's.
  const kept = useMemo(() => filterChatRows(rows, filter, marks), [rows, filter, marks])
  const shown = useMemo(() => chatList(kept, query), [kept, query])
  const empty = kept.length === 0 ? emptyOf(filter) : shown.length === 0 ? "No chats match." : null

  // A chat is made first and the address moved after it: onto the list's own entry where the list
  // was pushed, so a switch costs no rung, and above it where the list is the root. The entry says
  // which bot it is for, so the list keeps its lane while the new row loads.
  const start = async () => {
    const chat = await beginChat(bot.id)
    navigate(`/c/${chat.id}`, { state: { bot: bot.id }, replace: pushed })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ChatHeader
        pinned
        showBot={false}
        leading={
          pushed ? (
            <BackButton
              label={backToChat ? "Back to chat" : "Back"}
              onClick={back()}
              floating
            />
          ) : undefined
        }
        title={
          <Link
            to={botPath(bot.id)}
            className="-ml-2 flex min-h-11 min-w-0 items-center gap-2 rounded-full px-2 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden className="shrink-0">
              <Bot id={bot.botId} className="size-9" />
            </span>
            <span className="truncate">{bot.name}</span>
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
              {CHAT_FILTERS.map(({ key, label }) => (
                <Chip key={key} active={filter === key} onClick={() => chooseFilter(key)}>
                  {label}
                </Chip>
              ))}
            </ChipRow>
          </div>
        }
      />

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {empty && <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>}

        <ul className="flex flex-col">
          {shown.map((row) => (
            <li key={row.id}>
              <BotChatItem
                row={row}
                now={now}
                mark={marks[row.id]}
                selected={row.id === selected}
                profileId={bot.id}
                // Only a chat of the bot's takes the list's place: a room and a routine's run are
                // screens of their own whose way back is this list, so they stay above it.
                replace={pushed && !row.room && !row.routine}
                live={row.session ? runs[row.session] : undefined}
              />
            </li>
          ))}
        </ul>
      </div>

      <ListFoot
        canMakeRoom={canMakeRoom}
        searchable={!wide}
        query={query}
        onQueryChange={setQuery}
        onNewChat={() => void start()}
        onNewRoom={() => navigate("/new-room")}
      />
    </div>
  )
}

/**
 * One row of the list: a chat's icon — every row here is the same bot's, so the bot's face would say
 * nothing — its title, the bot's last word, its age, and the dot this device's read mark decides. The
 * row of the chat drawn beside the list is marked as the one open, as Code's list marks its own.
 *
 * The icon says what is happening, in the three states Code's rows use: a chat at rest is grey, the
 * app's own colour for nothing to say; a run in flight — the host's answer, else a reply this device
 * still watches arrive — is a spinner, so a list of quiet rows shows the one that is working; and a
 * row that waits on the reader takes the alert icon in the warning tone, with the reason in place of
 * the line. Yellow is spent on the one thing that wants the reader, never on nothing happening.
 *
 * A routine's delivery is a row of this list too, and wears the routine's icon rather than a chat's,
 * because it is a run rather than a chat with the bot: its line and time are the record's, since
 * the run's words are in the run's own session.
 *
 * A room is one of these rows, drawn by the same rule: it wears its members' pictures where a chat
 * wears its icon and says the last message received in it, and while its own log ends asking the
 * reader for something its line is that sentence, in the warning tone, because the line is where the
 * room's own screen says it too (ADR 0115, ADR 0126).
 *
 * The link names the bot it is a chat of, so the shell keeps the list's lane while the row loads.
 */
export function BotChatItem({
  row,
  now,
  mark,
  selected,
  profileId,
  replace,
  live,
}: {
  row: ChatListRow
  now: number
  mark?: number
  selected?: boolean
  profileId: string
  /** Whether the pick takes the entry the list itself stands on, which a list over a chat does. */
  replace?: boolean
  /** What the host says of this chat's run: `running` beats a reply still streaming here. */
  live?: LiveRunStatus
}) {
  const working = runInFlight(live, { streaming: row.streaming, waiting: Boolean(row.needs) })
  return (
    <ItemRow
      icon={
        row.routine ? (
          <RotateCcwClockIcon />
        ) : row.needs ? (
          <CircleAlertIcon />
        ) : working ? (
          <Spinner />
        ) : (
          <MessageCircleIcon />
        )
      }
      avatar={
        row.room ? (
          <RoomFaces shown={row.room.shown} more={row.room.more} label={row.room.names} />
        ) : undefined
      }
      tone={row.room ? undefined : row.needs ? "warning" : "muted"}
      unread={isUnread(row.at, mark)}
      selected={selected}
      title={row.title}
      when={chatAge(row.at, now)}
      line={pinnedLine(row.pinned, row.needs ?? row.line)}
      warn={Boolean(row.needs)}
      link={{ to: `/c/${row.id}`, state: { bot: profileId }, replace }}
    />
  )
}
