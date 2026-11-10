import type { CSSProperties } from "react"
import { useMemo, useRef, useState } from "react"
import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { MenuIcon, MessageCircleIcon, PlusIcon, SearchIcon } from "lucide-react"
import { Link, Navigate, useNavigate, useParams } from "react-router"

import { Bot } from "@/components/bot"
import { useOpenDrawer } from "@/components/drawer-context"
import { ItemRow, pinnedLine, SearchField } from "@/components/item-list"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { botPath } from "@/lib/bot-tabs"
import { chatAge, chatList, chatRowOf, type ChatListRow } from "@/lib/chat-list"
import { db, type Profile } from "@/lib/db"
import { listsAsChat } from "@/lib/lists-as-chat"
import { useReadMarks } from "@/lib/read-marks"
import { isUnread } from "@/lib/session-work"
import { beginChat, useBotThreads, useNow } from "@/lib/threads"

/** How many of a bot's newest chats its screen reads, the bound the sidebar holds them to as well. */
const CHATS = 50
const SEARCH_FIELD_ID = "chats-search"

/**
 * A bot's screen: the list of its chats, one flat band — the pinned ones first and the rest by what
 * was last said in them. Its header is the bot itself, whose name is the way to its settings, and its
 * foot starts a chat or a room. The list is a root screen, so its own back leaves the app (G5).
 */
export function BotChatsPage() {
  const { profileId } = useParams()
  const enabled = useBotThreads()
  // A bot's chats, each with the one read of its newest message that a row's line and time come from.
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
  // Nothing is drawn before the switches answer, and a bot that is gone — or a device on the legacy
  // layout, where a bot has no screen — lands home rather than on a list it cannot fill.
  if (enabled === undefined || !fresh) return null
  if (!enabled || !fresh.bot) return <Navigate to="/" replace />
  return <ChatList bot={fresh.bot} rows={fresh.rows} />
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

function ChatList({ bot, rows }: { bot: Profile; rows: ChatListRow[] }) {
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
  const start = async () => {
    const chat = await beginChat(bot.id)
    navigate(`/c/${chat.id}`)
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
              <BotChatItem row={row} now={now} mark={marks[row.id]} />
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
 * that waits on the reader wears the warning tone and says so beside the title; its line stays.
 */
export function BotChatItem({ row, now, mark }: { row: ChatListRow; now: number; mark?: number }) {
  return (
    <ItemRow
      icon={<MessageCircleIcon />}
      tone={row.waiting ? "warning" : undefined}
      unread={isUnread(row.at, mark)}
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
      link={{ to: `/c/${row.id}` }}
    />
  )
}
