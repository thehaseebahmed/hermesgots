import type { CSSProperties, ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { MenuIcon, MessageCircleIcon, PlusIcon, SearchIcon, TimerIcon, UsersIcon } from "lucide-react"
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
} from "react-router"

import { Bot } from "@/components/bot"
import { useOpenDrawer } from "@/components/drawer-context"
import { ItemRow, pinnedLine, SearchField } from "@/components/item-list"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { RoomFaces } from "@/components/room/room-faces"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { botPath, botRoutinesPath } from "@/lib/bot-tabs"
import { BOT_CHATS, chatAge, chatList, chatRowOf, type ChatListRow } from "@/lib/chat-list"
import { conversationsOf, db, isReply, newestMessage, type Profile } from "@/lib/db"
import { landingChat } from "@/lib/last-chat"
import { listsAsChat } from "@/lib/lists-as-chat"
import { BACK_ON_LIST } from "@/lib/nav"
import { useBotChatsPane, type BotPane } from "@/lib/pane"
import { useReadMarks } from "@/lib/read-marks"
import { useCanMakeRoom, useRoomNeeds } from "@/lib/room"
import { roomRowOf } from "@/lib/rooms"
import { isUnread } from "@/lib/session-work"
import { useLegacyChat } from "@/lib/legacy-chat"
import { beginChat, useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"

const SEARCH_FIELD_ID = "chats-search"

/**
 * A bot's screen: the list of its chats, one flat band — the pinned ones first and the rest by what
 * was last said in them. Its header is the bot itself, whose name is the way to its settings, and the
 * two controls it floats over the foot search the list and start something in it: a chat, or a room.
 * The list is a root screen, so its own back leaves the app, and a reader arriving at it lands in the
 * chat this device last had open here.
 *
 * Where there is room the list is the pane and the chat it opened stands beside it
 * (`useBotChatsPane`), so this screen is then the item lane with nothing open; below that width the
 * list is the whole screen and a chat is pushed over it, with the way back a screen of its own has.
 */
export function BotChatsPage() {
  const { profileId } = useParams()
  const legacy = useLegacyChat()
  const enabled = legacy === false
  const pane = useBotChatsPane(enabled)
  const landing = useLanding(profileId, enabled)
  // Nothing is drawn before the layout answers, and a device on the legacy layout — where a bot has
  // no screen — lands home rather than on a list it cannot fill.
  if (legacy === undefined) return null
  if (!enabled || !profileId) return <Navigate to="/" replace />
  // The chat the address opens is on its way, so neither the list it is leaving nor an empty pane is
  // drawn for a frame.
  if (landing) return null
  if (pane) return <NoChatOpen />
  return <BotChatsList profileId={profileId} />
}

/**
 * The chat a bot's address opens: the one this device last had open there, while it is still one of
 * the bot's. A reader who arrives at the address steps into that chat; one who steps back onto the
 * list gets the list — the press arrives as a pop, and the entry a chat's own control leaves in its
 * place says the reader is back on the list — so a press back never bounces into the chat it came
 * from.
 *
 * Answers whether the address is still being settled — the read is out, or a chat is taking it —
 * which the screen draws nothing for, so neither the list it is leaving nor an empty pane is drawn
 * for a frame.
 */
function useLanding(profileId: string | undefined, enabled: boolean | undefined) {
  const navigate = useNavigate()
  const type = useNavigationType()
  const listed = Boolean((useLocation().state as typeof BACK_ON_LIST | null)?.listed)
  const answer = useLiveQuery(
    async () =>
      profileId && enabled
        ? { profileId, chat: (await landingChat(profileId)) ?? null }
        : undefined,
    [profileId, enabled],
  )
  const chat = answer && answer.profileId === profileId ? answer.chat : undefined
  const opens = type !== "POP" && !listed && Boolean(chat)
  // One landing per visit: a second effect (a strict-mode double run) opens nothing again, and the
  // push it leaves is the entry the chat's own control steps back from.
  const opened = useRef(false)
  useEffect(() => {
    if (!opens || opened.current) return
    opened.current = true
    navigate(`/c/${chat}`)
  }, [opens, chat, navigate])
  return chat === undefined || opens
}

/**
 * The list kept on screen beside the chat it opened (see `useBotChatsPane`). It lands in nothing: a
 * chat this device would open is the address the chat's own list row takes.
 */
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
function BotChatsList({ profileId, selected }: { profileId: string; selected?: string }) {
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
        // A question or an approval sits on a reply, so a chat whose newest row is the reader's own
        // still waits while the reply above it does.
        const waits =
          newest && !isReply(newest) ? await newestMessage(chat.id, isReply) : undefined
        return chatRowOf(chat, newest, waits)
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
    .map((room) => roomRowOf(room.chat, room.faces))
  return <ChatList bot={fresh.bot} rows={[...fresh.rows, ...seated]} selected={selected} />
}

function ChatList({
  bot,
  rows,
  selected,
}: {
  bot: Profile
  rows: ChatListRow[]
  selected?: string
}) {
  const openDrawer = useOpenDrawer()
  const navigate = useNavigate()
  const marks = useReadMarks()
  // A room is made on a Host that advertises it, so the control is offered only where it can be used
  // — the same rule the legacy layout's Rooms section keeps (ADR 0129).
  const canMakeRoom = useCanMakeRoom()
  const now = useNow()
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [starting, setStarting] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const searchToggle = useRef<HTMLButtonElement>(null)
  const newToggle = useRef<HTMLButtonElement>(null)

  const shown = useMemo(() => chatList(rows, query), [rows, query])

  const openSearch = () => {
    setSearching(true)
    window.requestAnimationFrame(() => field.current?.focus())
  }
  const closeSearch = () => {
    setSearching(false)
    setQuery("")
    window.requestAnimationFrame(() => searchToggle.current?.focus())
  }
  // A chat is made first and the address moved after it, so back from it has the list to return to.
  // The entry says which bot it is for, so the list keeps its lane while the new row loads.
  const start = async () => {
    const chat = await beginChat(bot.id)
    navigate(`/c/${chat.id}`, { state: { bot: bot.id } })
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      style={
        {
          "--list-header-pt": "max(0.75rem, env(safe-area-inset-top))",
          "--list-header-h": "calc(var(--list-header-pt) + 3.5rem)",
        } as CSSProperties
      }
    >
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[var(--list-header-pt)] pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 shrink-0 rounded-full md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
          <h1 className="min-w-0 flex-1">
            <Link
              to={botPath(bot.id)}
              className="-ml-2 flex min-h-11 min-w-0 items-center gap-2 rounded-full px-2 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span aria-hidden className="shrink-0">
                <Bot id={bot.botId} className="size-9" />
              </span>
              <span className="truncate text-xl font-semibold tracking-tight">{bot.name}</span>
            </Link>
          </h1>
          <Link
            to={botRoutinesPath(bot.id)}
            aria-label="Routines"
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-lg" }),
              "size-11 shrink-0 rounded-full text-muted-foreground",
            )}
          >
            <TimerIcon />
          </Link>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {searching && (
          <SearchField
            id={SEARCH_FIELD_ID}
            value={query}
            // An empty field is a search that found everything, not a reason to shut: Escape and the
            // toggle are the two ways this closes, so backspacing the last character — or the
            // field's own clear control — keeps the focus and the keyboard where the reader is.
            onChange={setQuery}
            label="Search chats"
            inputRef={field}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSearch()
            }}
          />
        )}

        {rows.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No chats yet.</p>
        )}
        {rows.length > 0 && shown.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No chats match.</p>
        )}

        <ul className="flex flex-col">
          {shown.map((row) => (
            <li key={row.id}>
              <BotChatItem
                row={row}
                now={now}
                mark={marks[row.id]}
                selected={row.id === selected}
                profileId={bot.id}
              />
            </li>
          ))}
        </ul>
      </div>

      {/*
        The list's two floating controls, on the one bar the app's lists give their foot. The search
        sits at the left where a thumb reaches without crossing the list, and the one accent the
        screen spends starts a chat or a room. The bar keeps its place in the flow (`sticky`, not
        `fixed`), so the last row ends above it and is reachable rather than hidden behind it.
      */}
      <div
        data-slot="list-foot"
        className="pointer-events-none sticky bottom-0 z-20 mt-auto bg-gradient-to-t from-background via-background/90 to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-2">
          <Button
            ref={searchToggle}
            variant="outline"
            size="icon-lg"
            className="pointer-events-auto size-14 shrink-0 rounded-full bg-background shadow-lg"
            onClick={() => (searching ? closeSearch() : openSearch())}
            aria-label="Search"
            aria-expanded={searching}
            aria-controls={searching ? SEARCH_FIELD_ID : undefined}
            data-search-toggle
          >
            <SearchIcon className="size-5" />
          </Button>
          <Button
            ref={newToggle}
            data-toast-above
            data-new-menu
            size="icon-lg"
            className="pointer-events-auto size-14 shrink-0 rounded-full shadow-lg"
            onClick={() => setStarting(true)}
            aria-label="New"
          >
            <PlusIcon className="size-6" />
          </Button>
        </div>
      </div>

      {/*
        A one-tap pick from the button above it, so it is the app's pop-up: a sheet on a phone and a
        menu beside the button from 1024px, holding the two ways to start something. New room is a row
        only where the Host makes one, and a menu left with one row is still the way this pick is
        drawn.
      */}
      <Popup open={starting} onOpenChange={setStarting} anchor={newToggle}>
        <PopupContent size="md" toastAbove>
          <PopupHeader>
            <PopupTitle>New</PopupTitle>
          </PopupHeader>
          <div className="flex flex-col gap-1 px-2 pb-2">
            <NewRow
              icon={<MessageCircleIcon />}
              label="New chat"
              detail="A chat with this bot"
              onPick={() => {
                setStarting(false)
                void start()
              }}
            />
            {canMakeRoom && (
              <NewRow
                icon={<UsersIcon />}
                label="New room"
                detail="Bring other bots into one chat"
                onPick={() => {
                  setStarting(false)
                  navigate("/new-room")
                }}
              />
            )}
          </div>
        </PopupContent>
      </Popup>
    </div>
  )
}

/**
 * One row of the new menu: what it starts, and what that is, as a full-width target a thumb hits at
 * either form — a sheet's row on a phone, a menu's row beside the button from 1024px.
 */
function NewRow({
  icon,
  label,
  detail,
  onPick,
}: {
  icon: ReactNode
  label: string
  detail: string
  onPick: () => void
}) {
  return (
    <button
      type="button"
      // The name is the action alone: the detail is the line under it, not part of what it is called.
      aria-label={label}
      onClick={onPick}
      className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden className="shrink-0 text-muted-foreground [&_svg]:size-5">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
}

/**
 * One row of the list: a chat's icon — every row here is the same bot's, so the bot's face would say
 * nothing — its title, its last line, its age, and the dot this device's read mark decides. A reply
 * that waits on the reader wears the warning tone and says so beside the title; its line stays. The
 * row of the chat drawn beside the list is marked as the one open, as Code's list marks its own.
 *
 * A routine's delivery is a row of this list too, and wears the routine's icon rather than a chat's,
 * because it is a run rather than a chat with the bot: its line and time are the record's, since
 * the run's words are in the run's own session.
 *
 * A room is one of these rows, drawn by the same rule: it wears its members' pictures where a chat
 * wears its icon and names them in its line, and while its own log ends asking the reader for
 * something its line is that sentence, in the warning tone, because the line is where the room's own
 * screen says it too (ADR 0115, ADR 0126).
 *
 * The link names the bot it is a chat of, so the shell keeps the list's lane while the row loads.
 */
export function BotChatItem({
  row,
  now,
  mark,
  selected,
  profileId,
}: {
  row: ChatListRow
  now: number
  mark?: number
  selected?: boolean
  profileId: string
}) {
  return (
    <ItemRow
      icon={row.routine ? <TimerIcon /> : <MessageCircleIcon />}
      avatar={row.room ? <RoomFaces shown={row.room.shown} more={row.room.more} /> : undefined}
      tone={row.room ? undefined : row.waiting ? "warning" : undefined}
      unread={isUnread(row.at, mark)}
      selected={selected}
      badge={
        row.waiting && !row.room ? (
          <Badge data-waiting className="bg-warning/15 text-warning">
            Needs you
          </Badge>
        ) : undefined
      }
      title={row.title}
      when={chatAge(row.at, now)}
      line={pinnedLine(row.pinned, row.needs ?? row.line)}
      warn={Boolean(row.needs)}
      link={{ to: `/c/${row.id}`, state: { bot: profileId } }}
    />
  )
}
