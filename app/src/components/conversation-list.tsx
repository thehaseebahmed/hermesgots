import { useLiveQuery } from "dexie-react-hooks"
import { matchPath, NavLink, useLocation, type NavLinkProps } from "react-router"
import {
  ArrowDownUpIcon,
  AudioLinesIcon,
  BellOffIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  ListChecksIcon,
  MessageCircleQuestionMarkIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SailboatIcon,
  SearchIcon,
  ShieldAlertIcon,
  TelescopeIcon,
  TimerIcon,
  UserIcon,
} from "lucide-react"

import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import Dexie from "dexie"
import type { BotSort, Message } from "@/lib/db"
import { db } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { useMeetingsEnabled } from "@/lib/meetings"
import { useNav } from "@/lib/nav"
import { useSyncState } from "@/lib/sync"
import {
  BOT_SORTS,
  sortBots,
  useBotSort,
  useBotSummaries,
  useBotThreads,
  useNow,
} from "@/lib/threads"
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
function RootLink({ to, onClick, ...props }: NavLinkProps & { to: string }) {
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
  theseus: SailboatIcon,
}

/**
 * The newest chats across every bot, each with its bot's image, and a dot at the row's end when one
 * waits on the user. Project sessions stay on Code.
 */
function Recents({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
}) {
  const live = useWaiting()
  const recents = useLiveQuery(async () => {
    const profiles = await db.profiles.toArray()
    const bots = new Map(profiles.map((p) => [p.id, p]))
    const chats = await db.conversations
      .orderBy("updatedAt")
      .reverse()
      .filter((c) => !c.projectId && !bots.get(c.profileId)?.disabled)
      .limit(RECENTS)
      .toArray()
    // This device's own unanswered approval or question, which a keyless bot or one without the
    // plugin can't report. Only a chat's newest reply can wait, so only that one is read.
    const newest = await Promise.all(
      chats.map((c) =>
        db.messages
          .where("[conversationId+createdAt]")
          .between([c.id, Dexie.minKey], [c.id, Dexie.maxKey])
          .reverse()
          .filter((m) => m.role === "assistant")
          .first(),
      ),
    )
    const open = newest.filter(
      (m): m is Message =>
        !!(m?.approval && !m.approval.resolved) || !!(m?.clarify && !m.clarify.resolved),
    )
    const local = new Map<string, WaitingReason>(
      open.map((m) => [
        m.conversationId,
        m.clarify && !m.clarify.resolved
          ? { kind: "question", count: m.clarify.questions.length || 1 }
          : { kind: "approval", command: m.approval?.command },
      ]),
    )
    return chats.map((chat) => ({ chat, bot: bots.get(chat.profileId), local: local.get(chat.id) }))
  }, [])

  return (
    <nav
      className="flex flex-col gap-0.5"
      aria-labelledby={collapsed ? undefined : "recents-heading"}
      aria-label={collapsed ? "Recent chats" : undefined}
    >
      {!collapsed && (
        <h2
          id="recents-heading"
          className="px-3 pt-1 pb-2 text-sm font-medium text-muted-foreground"
        >
          Recents
        </h2>
      )}
      {!collapsed && recents?.length === 0 && (
        <p className="px-3 py-2 text-sm text-muted-foreground">No chats yet. Say hi to Hermes!</p>
      )}
      <ul className="flex flex-col gap-0.5">
        {recents?.map(({ chat, bot, local }) => {
          const reason = local ?? live[chat.hermesSessionId]
          return (
            <li key={chat.id}>
              <RootLink
                to={`/c/${chat.id}`}
                onClick={onNavigate}
                aria-label={collapsed ? chat.title : undefined}
                className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
              >
                <Bot id={bot?.botId} className="size-5" />
                {!collapsed && <span className="min-w-0 flex-1 truncate">{chat.title}</span>}
                {!collapsed && reason && (
                  <>
                    <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
                    <span className="sr-only">{reasonText(reason)}</span>
                  </>
                )}
              </RootLink>
            </li>
          )
        })}
      </ul>
      {!collapsed && (recents?.length ?? 0) > 0 && (
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
 */
function Bots({ onNavigate, collapsed = false }: { onNavigate?: () => void; collapsed?: boolean }) {
  const summaries = useBotSummaries()
  const [sort, setSort] = useBotSort()
  const bots = summaries && sortBots(summaries, sort)
  const { pathname } = useLocation()
  const chat = matchPath("/c/:id", pathname)?.params.id
  const owner = useLiveQuery(
    async () => (chat ? (await db.conversations.get(chat))?.profileId : undefined),
    [chat],
  )
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
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-11 gap-1.5 rounded-full px-3 text-xs text-muted-foreground"
                  aria-label={`Sort bots by ${BOT_SORTS[sort]}`}
                />
              }
            >
              <ArrowDownUpIcon />
              {BOT_SORTS[sort]}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Sort bots by</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(value) => setSort(value as BotSort)}
                >
                  {(Object.keys(BOT_SORTS) as BotSort[]).map((option) => (
                    <DropdownMenuRadioItem
                      key={option}
                      value={option}
                      className="min-h-11"
                      closeOnClick
                    >
                      {BOT_SORTS[option]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <ul className="flex flex-col gap-0.5">
        {bots?.map(({ bot, latest, waiting }) => (
          <li key={bot.id}>
            <RootLink
              to={`/b/${bot.id}`}
              onClick={onNavigate}
              aria-label={collapsed ? bot.name : undefined}
              className={({ isActive }) =>
                collapsed
                  ? railClass({ isActive: isActive || owner === bot.id })
                  : cn(rowClass({ isActive: isActive || owner === bot.id }), "min-h-14 py-2")
              }
            >
              <Bot id={bot.botId} className="size-9" />
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
                    {latest && (
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">
                        {formatRelative(latest.updatedAt, now)}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">
                      {latest?.title ?? "No threads yet"}
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
        ))}
        <li>
          <RootLink
            to="/settings/bots?link=1"
            onClick={onNavigate}
            aria-label={collapsed ? "Link a bot" : undefined}
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
            {!collapsed && "Link a bot"}
          </RootLink>
        </li>
      </ul>
    </nav>
  )
}

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
        <ul className="flex flex-col gap-0.5">
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
  const botThreads = useBotThreads()
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
        <Button variant="ghost" size="icon-lg" className="size-11 rounded-full" aria-label="Search">
          <SearchIcon />
        </Button>
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 rounded-full"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <nav className="flex flex-col gap-0.5" aria-label="Main">
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
          <RootLink
            to="/routines"
            onClick={onNavigate}
            aria-label={collapsed ? "Routines" : undefined}
            className={({ isActive }) => (collapsed ? railClass : rowClass)({ isActive })}
          >
            <TimerIcon className="size-5 text-muted-foreground" />
            {!collapsed && "Routines"}
          </RootLink>
        </nav>
        <Separator className="mx-1 my-3 data-horizontal:w-auto" />
        <Waiting onNavigate={onNavigate} collapsed={collapsed} />
        {botThreads ? (
          <Bots onNavigate={onNavigate} collapsed={collapsed} />
        ) : (
          botThreads === false && <Recents onNavigate={onNavigate} collapsed={collapsed} />
        )}
      </div>

      <div
        className={cn(
          "flex items-center justify-between gap-3 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]",
          collapsed && "flex-col justify-center gap-2 px-2",
        )}
      >
        <ProfileButton onNavigate={onNavigate} />
        {botThreads === false && (
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
  )
}
