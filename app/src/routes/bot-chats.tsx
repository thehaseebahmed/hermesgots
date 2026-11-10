import type { CSSProperties } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { MenuIcon, MessageCircleIcon, PlusIcon, SearchIcon } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { botPath } from "@/lib/bot-tabs"
import { chatAge, chatList, chatRowOf, type ChatListRow } from "@/lib/chat-list"
import { db, type Profile } from "@/lib/db"
import { landingChat } from "@/lib/last-chat"
import { listsAsChat } from "@/lib/lists-as-chat"
import { BACK_ON_LIST } from "@/lib/nav"
import { useBotChatsPane, type BotPane } from "@/lib/pane"
import { useReadMarks } from "@/lib/read-marks"
import { isUnread } from "@/lib/session-work"
import { beginChat, useBotThreads, useNow } from "@/lib/threads"

/** How many of a bot's newest chats its screen reads, the bound the sidebar holds them to as well. */
const CHATS = 50
const SEARCH_FIELD_ID = "chats-search"

/**
 * A bot's screen: the list of its chats, one flat band — the pinned ones first and the rest by what
 * was last said in them. Its header is the bot itself, whose name is the way to its settings, and its
 * foot starts a chat or a room. The list is a root screen, so its own back leaves the app (G5), and a
 * reader arriving at it lands in the chat this device last had open here (G1).
 *
 * Where there is room the list is the pane and the chat it opened stands beside it
 * (`useBotChatsPane`), so this screen is then the item lane with nothing open; below that width the
 * list is the whole screen and a chat is pushed over it, with the way back a screen of its own has.
 */
export function BotChatsPage() {
  const { profileId } = useParams()
  const enabled = useBotThreads()
  const pane = useBotChatsPane(enabled)
  const landing = useLanding(profileId, enabled)
  // Nothing is drawn before the switches answer, and a device on the legacy layout — where a bot has
  // no screen — lands home rather than on a list it cannot fill.
  if (enabled === undefined) return null
  if (!enabled || !profileId) return <Navigate to="/" replace />
  // The chat the address opens is on its way, so neither the list it is leaving nor an empty pane is
  // drawn for a frame.
  if (landing !== "none") return null
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
 * `out` while the read is out, `opens` while a chat is taking the address, `none` for a bot with
 * nothing to open.
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
  if (chat === undefined) return "out"
  return opens ? "opens" : "none"
}

/**
 * The list kept on screen beside the chat it opened (see `useBotChatsPane`). It lands in nothing: a
 * chat this device would open is the address the chat's own list row takes.
 */
export function BotChatsPane({ pane }: { pane: BotPane }) {
  return <BotChatsList profileId={pane.profileId} selected={pane.selected} />
}

/**
 * The item lane a bot's screen is where the list stands beside it and no chat is open: the reader
 * stepped back onto the list, and the row they pick draws its chat in this place.
 */
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

/** A chat's newest message this device holds: the one read a row's line and its time both come from. */
function newestIn(conversationId: string) {
  return db.messages
    .where("[conversationId+createdAt]")
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
    .reverse()
    .filter((message) => Boolean(message.content.trim()))
    .first()
}

/** A bot's chats, each with the one read of its newest message that a row's line and time come from. */
function BotChatsList({ profileId, selected }: { profileId: string; selected?: string }) {
  // The answer names the address it ran for, so one bot's answer can never pass for another's.
  const answer = useLiveQuery(async () => {
    if (!profileId) return { profileId, bot: null, rows: [] }
    const bot = await db.profiles.get(profileId)
    if (!bot) return { profileId, bot: null, rows: [] }
    const chats = await db.conversations
      .where("[profileId+updatedAt]")
      .between([profileId, -Infinity], [profileId, Infinity])
      .reverse()
      .filter(listsAsChat)
      .limit(CHATS)
      .toArray()
    const rows = await Promise.all(
      chats.map(async (chat) => chatRowOf(chat, await newestIn(chat.id))),
    )
    return { profileId, bot, rows }
  }, [profileId])
  const fresh = answer && answer.profileId === profileId ? answer : undefined
  if (!fresh) return null
  // A bot that is gone — deleted here or on another device — lands home rather than on a list it
  // cannot fill.
  if (!fresh.bot) return <Navigate to="/" replace />
  return <ChatList bot={fresh.bot} rows={fresh.rows} selected={selected} />
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
  const now = useNow()
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const searchToggle = useRef<HTMLButtonElement>(null)

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
          {/* The bot's own name is the way into its settings, so the heading is a link and reads as one. */}
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
          <Button
            ref={searchToggle}
            variant="ghost"
            size="icon-lg"
            className="size-11 shrink-0 rounded-full text-muted-foreground"
            onClick={() => (searching ? closeSearch() : openSearch())}
            aria-label="Search"
            aria-expanded={searching}
            aria-controls={searching ? SEARCH_FIELD_ID : undefined}
            data-search-toggle
          >
            <SearchIcon />
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {searching && (
          <SearchField
            id={SEARCH_FIELD_ID}
            value={query}
            onChange={(next) => (next ? setQuery(next) : closeSearch())}
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

      <div className="pointer-events-none sticky bottom-0 z-20 mt-auto bg-gradient-to-t from-background via-background/90 to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-2">
          <Button
            data-toast-above
            variant="outline"
            size="lg"
            className="pointer-events-auto h-12 rounded-full px-5"
            onClick={() => navigate("/new-room")}
          >
            New room
          </Button>
          <Button
            data-toast-above
            size="lg"
            className="pointer-events-auto h-12 rounded-full px-5 shadow-lg"
            onClick={() => void start()}
          >
            <PlusIcon /> New chat
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * One chat's row: a chat's icon — every row here is the same bot's, so the bot's face would say
 * nothing — its title, its last line, its age, and the dot this device's read mark decides. A reply
 * that waits on the reader wears the warning tone and says so beside the title; its line stays. The
 * row of the chat drawn beside the list is marked as the one open, as Code's list marks its own.
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
      icon={<MessageCircleIcon />}
      tone={row.waiting ? "warning" : undefined}
      unread={isUnread(row.at, mark)}
      selected={selected}
      badge={
        row.waiting ? (
          <Badge data-waiting className="bg-warning/15 text-warning">
            Needs you
          </Badge>
        ) : undefined
      }
      title={row.title}
      when={chatAge(row.at, now)}
      line={pinnedLine(row.pinned, row.line)}
      link={{ to: `/c/${row.id}`, state: { bot: profileId } }}
    />
  )
}
