import { useLiveQuery } from "dexie-react-hooks"
import type { ReactNode } from "react"
import { matchPath, NavLink, useLocation, type NavLinkProps } from "react-router"
import {
  AudioLinesIcon,
  BellOffIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  FolderKanbanIcon,
  ListChecksIcon,
  FrameIcon,
  MessageCircleQuestionMarkIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  RotateCcwClockIcon,
  SearchIcon,
  ShieldAlertIcon,
  TelescopeIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react"

import { Bot } from "@/components/bot"
import { RoomFaces } from "@/components/room/room-faces"
import { SortMenu } from "@/components/sort-menu"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { botChatsPath } from "@/lib/bot-tabs"
import { previewLine } from "@/lib/bot-chrome"
import { usePinnedCanvases } from "@/lib/canvases"
import { chatOwner } from "@/lib/chat-owner"
import { compareChatOrder, waitsOnUser } from "@/lib/chat-list"
import { presence } from "@/lib/registry"
import type { Conversation, Message, Profile } from "@/lib/db"
import { db, isReply, newestMessage } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { useCanMakeRoom, useRoomNeeds, type RoomNeedsRow } from "@/lib/room"
import { roomMembersLine, roomNeedsOf } from "@/lib/rooms"
import { useLegacyChat } from "@/lib/legacy-chat"
import { useMeetingsEnabled } from "@/lib/meetings"
import { useNav } from "@/lib/nav"
import { useSyncState } from "@/lib/sync"
import { BOT_SORTS, sortBots, useBotSort, useBotSummaries, useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { reasonText, useWaiting, useWaitingSessions, type WaitingReason } from "@/lib/waiting"

const RECENTS = 10

const rowClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex min-h-11 items-center gap-3 rounded-2xl px-3 text-sm transition-colors hover:bg-muted",
    isActive && "bg-muted font-medium",
  )

const railClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex size-11 shrink-0 items-center justify-center rounded-2xl transition-colors hover:bg-muted",
    isActive && "bg-muted font-medium",
  )

/** A sidebar destination: top-level, so it opens as the only entry and back leaves the app. */
function RootLink({
  to,
  onClick,
  ...props
}: NavLinkProps & { to: string } & Record<`data-${string}`, string | undefined>) {
  const { root } = useNav()
  return (
    <NavLink
      to={to}
      replace
      onClick={(event) => {
        onClick?.(event)
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        root(to)
      }}
      {...props}
    />
  )
}

const REASON_ICONS: Record<WaitingReason["kind"], typeof ListChecksIcon> = {
  question: MessageCircleQuestionMarkIcon,
  approval: ShieldAlertIcon,
  plan: ListChecksIcon,
  stalled: TriangleAlertIcon,
}

/** A reason in words, or nothing at all where nothing waits: a chat at rest has none to say. */
const reasonTextOf = (reason?: WaitingReason) => (reason ? reasonText(reason) : undefined)

/** A row's age, in the one voice every list that draws one uses. */
function RowAge({ at, now }: { at: number; now: number }) {
  return (
    <span className="shrink-0 text-xs font-normal text-muted-foreground">
      {formatRelative(at, now)}
    </span>
  )
}

/**
 * One row of a chat list: the bot's picture, its name and what it holds, and a dot when it waits on
 * the user. A room is drawn by the same row — its name, the members it seats, its last activity and
 * the mark its own log reads (ADR 0120) — so a room and a chat are ordered, pinned and marked by one
 * rule (ADR 0116, ADR 0121).
 */
function ChatRow({
  chat,
  bot,
  faces,
  reason,
  now,
  collapsed,
  onNavigate,
}: {
  chat: Conversation
  bot?: Profile
  /** A room's members, as pictures: what the row draws instead of the one bot a chat is (ADR 0126). */
  faces?: { shown: string[]; more: number }
  /** What waits on the user, in words the screen reader hears: a chat's, or the room's own reading. */
  reason?: string
  now: number
  collapsed: boolean
  onNavigate?: () => void
}) {
  return (
    <RootLink
      to={`/c/${chat.id}`}
      onClick={onNavigate}
      // A rail draws no text, so the mark's words are the row's name: a room that needs the user
      // says so in the only place an icon-only rail can say it.
      aria-label={collapsed ? (reason ? `${chat.title}. ${reason}` : chat.title) : undefined}
      className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
    >
      {faces ? (
        <RoomFaces shown={faces.shown} more={faces.more} collapsed={collapsed} />
      ) : (
        <Bot id={bot?.botId} className="size-5" />
      )}
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{chat.title}</span>
            {/* A room is a conversation of several bots, so its row names them: the record a device
                merges carries its roster, and nothing of its transcript (ADR 0116). */}
            {chat.room && (
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {roomMembersLine(chat.room)}
              </span>
            )}
          </span>
          {chat.room && <RowAge at={chat.updatedAt} now={now} />}
          {reason && (
            <>
              <span
                aria-hidden
                data-needs-you
                className="size-2 shrink-0 rounded-full bg-warning"
              />
              <span className="sr-only">{reason}</span>
            </>
          )}
        </>
      )}
    </RootLink>
  )
}

/**
 * A band of the chat list: its heading, and the rows it holds, in the order the list decided. A band
 * with nothing in it draws nothing at all.
 */
function Band({
  name,
  label,
  collapsed,
  children,
}: {
  name: string
  label: string
  collapsed: boolean
  children: ReactNode
}) {
  return (
    <>
      {!collapsed && (
        <h2 id={`${name}-heading`} className="px-3 pt-1 pb-2 text-sm font-medium text-muted-foreground">
          {label}
        </h2>
      )}
      <ul
        data-band={name}
        aria-labelledby={collapsed ? undefined : `${name}-heading`}
        aria-label={collapsed ? label : undefined}
        className={cn("flex flex-col gap-0.5", collapsed && "items-center")}
      >
        {children}
      </ul>
    </>
  )
}

function PinnedCanvases({
  onNavigate,
  collapsed,
}: {
  onNavigate?: () => void
  collapsed: boolean
}) {
  const pinned = usePinnedCanvases()
  if (pinned.length === 0) return null
  return (
    <>
      {pinned.map((canvas) => (
        <RootLink
          key={canvas.id}
          to={`/canvas/${canvas.id}`}
          onClick={onNavigate}
          aria-label={collapsed ? canvas.title : undefined}
          data-canvas-pinned=""
          className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
        >
          <FrameIcon className="size-5 text-muted-foreground" />
          {!collapsed && <span className="min-w-0 truncate">{canvas.title}</span>}
        </RootLink>
      ))}
    </>
  )
}

/**
 * The newest chats across every bot, each with its bot's image, and a dot at the row's end when one
 * waits on the user. Project sessions stay on Code. A pinned chat is lifted into the band above —
 * ADR 0103's rule, read here over chats and rooms alike — and a room is one of these rows: it takes
 * its place among them by its last activity, and says it needs the user until it is opened.
 */
function Recents({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
}) {
  const live = useWaiting()
  const now = useNow()
  const recents = useLiveQuery(async () => {
    const profiles = await db.profiles.toArray()
    const bots = new Map(profiles.map((p) => [p.id, p]))
    // Pinned first by ADR 0103, so every listed chat is read: a pin may be older than the ten newest.
    const listed = await db.conversations
      .orderBy("updatedAt")
      .reverse()
      // Rooms have a section of their own, so Recents holds chats alone (ADR 0127).
      .filter((c) => chatOwner(c, bots).listed && !c.room)
      .toArray()
    const chats = [
      ...listed.filter((c) => c.pinned),
      ...listed.filter((c) => !c.pinned).slice(0, RECENTS),
    ]
    // This device's own unanswered approval or question, which a keyless bot or one without the
    // plugin can't report. Only a chat's newest reply can wait, so only that one is read.
    const newest = await Promise.all(chats.map((c) => newestMessage(c.id, isReply)))
    const open = newest.filter((m): m is Message => m !== undefined && waitsOnUser(m))
    const local = new Map<string, WaitingReason>(
      open.map((m) => [
        m.conversationId,
        m.clarify && !m.clarify.resolved
          ? { kind: "question", count: m.clarify.questions.length || 1 }
          : { kind: "approval", command: m.approval?.command },
      ]),
    )
    return chats.map((chat) => ({
      chat,
      bot: chatOwner(chat, bots).bot,
      local: local.get(chat.id),
    }))
  }, [])

  const pinned = recents?.filter((one) => one.chat.pinned) ?? []
  const rest = recents?.filter((one) => !one.chat.pinned) ?? []

  const rows = (band: typeof rest) =>
    band.map(({ chat, bot, local }) => (
      <li key={chat.id}>
        <ChatRow
          chat={chat}
          bot={bot}
          now={now}
          collapsed={collapsed}
          onNavigate={onNavigate}
          reason={reasonTextOf(local) ?? reasonTextOf(live[chat.hermesSessionId])}
        />
      </li>
    ))

  return (
    <nav
      className="flex flex-col gap-0.5"
      aria-labelledby={collapsed ? undefined : "recents-heading"}
      aria-label={collapsed ? "Recent chats" : undefined}
    >
      {pinned.length > 0 && (
        <Band name="pinned" label="Pinned" collapsed={collapsed}>
          {rows(pinned)}
        </Band>
      )}
      {rest.length > 0 && (
        <Band name="recents" label="Recents" collapsed={collapsed}>
          {rows(rest)}
        </Band>
      )}
      {!collapsed && recents && rest.length === 0 && pinned.length === 0 && (
        <p className="px-3 py-2 text-sm text-muted-foreground">No chats yet. Say hi to Hermes!</p>
      )}
      {!collapsed && rest.length > 0 && (
        <button
          type="button"
          className="flex min-h-11 items-center gap-1 rounded-2xl px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          View all
          <ChevronRightIcon className="size-4" />
        </button>
      )}
    </nav>
  )
}

/**
 * With bot threads on, in place of Recents: every bot that's turned on, each with its newest thread
 * and a count of the threads waiting on the user. A bot opens as one chat holding its threads.
 *
 * The Host's rooms are rows of the same list, after the bots: a room is nobody's thread, so it
 * belongs to no bot's row, and it is not a section of its own either — it is drawn by the chat
 * list's own row, with its members, its last activity and the mark its log reads (ADR 0115).
 */
function Bots({ onNavigate, collapsed = false }: { onNavigate?: () => void; collapsed?: boolean }) {
  const summaries = useBotSummaries()
  const [sort, setSort] = useBotSort()
  const bots = summaries && sortBots(summaries, sort)
  const { pathname } = useLocation()
  const chat = matchPath("/c/:id", pathname)?.params.id
  // The bot whose screen the address is, for the row that says so. A coding session belongs to its
  // bot but is not one of its threads — Code's list is where it stands — so opening one leaves the
  // bot's row alone.
  const owner = useLiveQuery(async () => {
    if (!chat) return undefined
    const found = await db.conversations.get(chat)
    return found ? chatOwner(found).answerer : undefined
  }, [chat])
  const now = useNow()

  return (
    <nav
      className="flex flex-col gap-0.5"
      aria-labelledby={collapsed ? undefined : "bots-heading"}
      aria-label={collapsed ? "Bots" : undefined}
    >
      {!collapsed && (
        <div className="-mt-2 flex items-center justify-between gap-2 pl-3">
          <h2 id="bots-heading" className="text-sm font-medium text-muted-foreground">
            Bots
          </h2>
          <SortMenu
            by="bots"
            label="Sort bots by"
            options={BOT_SORTS}
            value={sort}
            onSort={setSort}
          />
        </div>
      )}
      <ul className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
        {bots?.map(({ bot, latest, preview, waiting, unread }) => {
          const age = latest?.updatedAt
          return (
            <li key={bot.id}>
              <RootLink
                to={botChatsPath(bot.id)}
                onClick={onNavigate}
                aria-label={collapsed ? bot.name : undefined}
                className={({ isActive }) =>
                  collapsed
                    ? railClass({ isActive: isActive || owner === bot.id })
                    : cn(rowClass({ isActive: isActive || owner === bot.id }), "min-h-14 py-2")
                }
              >
                <span className="relative shrink-0">
                  <Bot id={bot.botId} className="size-9" />
                  {/* New since this device last looked at one of the bot's threads (ADR 0110). */}
                  {unread && (
                    <>
                      <span className="sr-only">New activity</span>
                      <span
                        data-unread
                        aria-hidden
                        className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-info ring-2 ring-sidebar"
                      />
                    </>
                  )}
                </span>
                {!collapsed && (
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{bot.name}</span>
                      {bot.muted && (
                        <BellOffIcon
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-label="Muted"
                        />
                      )}
                      {age && <RowAge at={age} now={now} />}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">
                        {previewLine({
                          line: preview,
                          title: latest?.title,
                          online: presence(bot, now),
                        })}
                      </span>
                      {waiting > 0 && (
                        <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-xs leading-5 font-semibold text-warning tabular-nums">
                          {waiting}
                          <span className="sr-only"> waiting for you</span>
                        </span>
                      )}
                    </span>
                  </span>
                )}
              </RootLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * The legacy layout's Rooms section: the Host's rooms, ranked as every list here ranks a row, with the
 * one control a room is started from at its end.
 *
 * Recents is the only list that layout has, and it holds chats alone, so this is where a room stands
 * (ADR 0115). The bot layout has no section of its own: a room is a row of every bot's chat list,
 * among the chats, so it needs neither a place here nor an order of its own. The section is drawn even
 * with no rooms in it: an empty room list is where someone who has never made a room finds the control.
 */
function Rooms({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
}) {
  const now = useNow()
  const rows = useRoomNeeds()
  const canMake = useCanMakeRoom()
  if (!rows) return null
  const ordered = [...rows].sort((one, two) => compareChatOrder(placeOf(one), placeOf(two)))
  return (
    <>
      <Separator className="mx-1 my-3 data-horizontal:w-auto" />
      <nav
        className="flex flex-col gap-0.5"
        aria-labelledby={collapsed ? undefined : "rooms-heading"}
        aria-label={collapsed ? "Rooms" : undefined}
      >
        {!collapsed && (
          <h2
            id="rooms-heading"
            className="px-3 pt-1 pb-2 text-sm font-medium text-muted-foreground"
          >
            Rooms
          </h2>
        )}
        <ul data-band="rooms" className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
          {ordered.map(({ chat, bot, faces }) => (
            <li key={chat.id}>
              <ChatRow
                chat={chat}
                bot={bot}
                faces={faces}
                reason={roomNeedsOf(chat)}
                now={now}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            </li>
          ))}
          {canMake && (
            <li>
              <RootLink
                to="/new-room"
                onClick={onNavigate}
                aria-label={collapsed ? "New room" : undefined}
                data-slot="new-room"
                className={({ isActive }) =>
                  cn(
                    collapsed ? railClass({ isActive }) : rowClass({ isActive }),
                    "text-muted-foreground",
                  )
                }
              >
                <span className="flex size-9 items-center justify-center">
                  <PlusIcon className="size-5" />
                </span>
                {!collapsed && "New room"}
              </RootLink>
            </li>
          )}
        </ul>
      </nav>
    </>
  )
}

const placeOf = ({ chat }: RoomNeedsRow) => ({
  id: chat.id,
  at: chat.updatedAt,
  pinned: Boolean(chat.pinned),
})

/** Project sessions, across every project, that wait on the user. Hidden when there are none. */
function Waiting({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
}) {
  const waiting = useWaitingSessions()
  if (!waiting.length) return null

  return (
    <>
      <nav
        className="flex flex-col gap-0.5"
        aria-labelledby={collapsed ? undefined : "waiting-heading"}
        aria-label={collapsed ? "Waiting for input" : undefined}
      >
        {!collapsed && (
          <h2
            id="waiting-heading"
            className="flex items-center gap-2 px-3 pt-1 pb-2 text-sm font-medium text-muted-foreground"
          >
            Waiting for input
            <span className="rounded-full bg-warning/15 px-1.5 text-xs leading-5 font-semibold text-warning tabular-nums">
              {waiting.length}
            </span>
          </h2>
        )}
        <ul className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
          {waiting.map(({ sessionId, title, reason, project }) => {
            const Icon = REASON_ICONS[reason.kind]
            return (
              <li key={sessionId}>
                <RootLink
                  to={`/c/${sessionId}`}
                  onClick={onNavigate}
                  aria-label={collapsed ? title : undefined}
                  className={(state) =>
                    collapsed ? railClass(state) : cn(rowClass(state), "py-2")
                  }
                >
                  <Icon
                    className={
                      collapsed
                        ? "size-5 shrink-0 text-warning"
                        : "size-5 shrink-0 self-start text-warning"
                    }
                  />
                  {!collapsed && (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{title}</span>
                      <span className="flex gap-1 text-xs text-muted-foreground">
                        <span className="max-w-full shrink-0 truncate">{reasonText(reason)}</span>
                        {project && <span className="min-w-0 truncate">· {project}</span>}
                      </span>
                    </span>
                  )}
                </RootLink>
              </li>
            )
          })}
        </ul>
      </nav>
      <Separator className="mx-1 my-3 data-horizontal:w-auto" />
    </>
  )
}

/** The signed-in GitHub picture, or a plain figure; opens Settings. */
function ProfileButton({ onNavigate }: { onNavigate?: () => void }) {
  const { account } = useSyncState()
  const picture = account.status === "signed-in" ? account.user.pictureUrl : undefined

  return (
    <RootLink
      to="/settings"
      onClick={onNavigate}
      aria-label="Settings"
      className={({ isActive }) =>
        cn(
          "flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground ring-1 ring-foreground/10 transition-shadow",
          isActive && "ring-2 ring-foreground/40",
        )
      }
    >
      {picture ? (
        <img src={picture} alt="" className="size-full object-cover" />
      ) : (
        <UserIcon className="size-5" />
      )}
    </RootLink>
  )
}

export function ConversationList({
  onNavigate,
  collapsed = false,
  onToggleCollapsed,
}: {
  onNavigate?: () => void
  /** Shrunk to icons. Only the docked sidebar passes it; the phone drawer always shows labels. */
  collapsed?: boolean
  /** Given only by the docked sidebar, so the drawer grows no collapse control of its own. */
  onToggleCollapsed?: () => void
}) {
  const { root } = useNav()
  const legacy = useLegacyChat()
  const meetings = useMeetingsEnabled()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={cn(
          "flex items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-2",
          collapsed && "flex-col gap-1 px-2",
        )}
      >
        {!collapsed && (
          <span className="flex-1 pl-1 text-xl font-semibold tracking-tight">Gots</span>
        )}
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="icon-lg"
            className={cn("size-11 rounded-full", collapsed && "text-muted-foreground")}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            {collapsed ? <PanelLeftOpenIcon className="size-5" /> : <PanelLeftCloseIcon />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-lg"
          className={cn("size-11 rounded-full", collapsed && "text-muted-foreground")}
          aria-label="Search"
        >
          <SearchIcon className={collapsed ? "size-5" : undefined} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <nav className={cn("flex flex-col gap-0.5", collapsed && "items-center")} aria-label="Main">
          <RootLink
            to="/projects"
            onClick={onNavigate}
            aria-label={collapsed ? "Projects" : undefined}
            className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
          >
            <FolderKanbanIcon className="size-5 text-muted-foreground" />
            {!collapsed && "Projects"}
          </RootLink>
          <RootLink
            to="/code"
            onClick={onNavigate}
            aria-label={collapsed ? "Code" : undefined}
            className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
          >
            <CodeXmlIcon className="size-5 text-muted-foreground" />
            {!collapsed && "Code"}
          </RootLink>
          <RootLink
            to="/canvas"
            onClick={onNavigate}
            aria-label={collapsed ? "Canvas" : undefined}
            className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
          >
            <FrameIcon className="size-5 text-muted-foreground" />
            {!collapsed && "Canvas"}
          </RootLink>
          <RootLink
            to="/research"
            onClick={onNavigate}
            aria-label={collapsed ? "Research" : undefined}
            className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
          >
            <TelescopeIcon className="size-5 text-muted-foreground" />
            {!collapsed && "Research"}
          </RootLink>
          {meetings && (
            <RootLink
              to="/meetings"
              onClick={onNavigate}
              aria-label={collapsed ? "Meetings" : undefined}
              className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
            >
              <AudioLinesIcon className="size-5 text-muted-foreground" />
              {!collapsed && "Meetings"}
            </RootLink>
          )}
          {legacy === true && (
            <RootLink
              to="/routines"
              onClick={onNavigate}
              aria-label={collapsed ? "Routines" : undefined}
              className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
            >
              <RotateCcwClockIcon className="size-5 text-muted-foreground" />
              {!collapsed && "Routines"}
            </RootLink>
          )}
          <PinnedCanvases onNavigate={onNavigate} collapsed={collapsed} />
        </nav>
        <Separator className="mx-1 my-3 data-horizontal:w-auto" />
        <Waiting onNavigate={onNavigate} collapsed={collapsed} />
        {legacy === false ? (
          <Bots onNavigate={onNavigate} collapsed={collapsed} />
        ) : (
          legacy === true && (
            <>
              <Recents onNavigate={onNavigate} collapsed={collapsed} />
              <Rooms onNavigate={onNavigate} collapsed={collapsed} />
            </>
          )
        )}
      </div>

      <div
        className={cn(
          "flex items-center justify-between gap-3 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]",
          collapsed && "flex-col justify-center gap-2 px-2",
        )}
      >
        <ProfileButton onNavigate={onNavigate} />
        <div className={cn("flex items-center gap-2", collapsed && "flex-col gap-2")}>
          {legacy === true && (
            <Button
              size="lg"
              className={cn("h-11 rounded-full", collapsed ? "w-11 px-0" : "px-5")}
              aria-label="New chat"
              onClick={() => {
                root("/")
                onNavigate?.()
              }}
            >
              <PlusIcon data-icon={collapsed ? undefined : "inline-start"} />
              {!collapsed && "New chat"}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
