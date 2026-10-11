import { useLiveQuery } from "dexie-react-hooks"
import { NavLink, type NavLinkProps } from "react-router"
import {
  ChevronRightIcon,
  CodeXmlIcon,
  ListChecksIcon,
  MessageCircleQuestionMarkIcon,
  PanelLeftCloseIcon,
  PlusIcon,
  SailboatIcon,
  SearchIcon,
  SettingsIcon,
  ShieldAlertIcon,
  TelescopeIcon,
  TimerIcon,
  UserIcon,
} from "lucide-react"

import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { db } from "@/lib/db"
import { useNav } from "@/lib/nav"
import { useResearchEnabled } from "@/lib/research"
import { useSyncState } from "@/lib/sync"
import { cn } from "@/lib/utils"
import { reasonText, useWaiting, useWaitingSessions, type WaitingReason } from "@/lib/waiting"
import { sidebarItemAccessibility } from "@/lib/sidebar"

const RECENTS = 10

const rowClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex min-h-11 items-center gap-3 rounded-2xl px-3 text-sm transition-colors hover:bg-muted",
    isActive && "bg-muted font-medium",
  )

// A 68px rail row holds one centered icon, so the padding and gap that framed the label go away.
const railRowClass = "justify-center px-0"

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
    // plugin can't report.
    const open = await db.messages
      .where("conversationId")
      .anyOf(chats.map((c) => c.id))
      .filter((m) => !!(m.approval && !m.approval.resolved) || !!(m.clarify && !m.clarify.resolved))
      .toArray()
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
      aria-label={collapsed ? "Recents" : undefined}
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
                className={(state) =>
                  cn(rowClass(state), collapsed && "relative", collapsed && railRowClass)
                }
                {...sidebarItemAccessibility(chat.title, collapsed)}
              >
                <Bot id={bot?.botId} className="size-5" />
                {!collapsed && <span className="min-w-0 flex-1 truncate">{chat.title}</span>}
                {reason && (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 shrink-0 rounded-full bg-warning",
                        collapsed && "absolute top-1.5 right-1.5",
                      )}
                    />
                    <span className="sr-only">{reasonText(reason)}</span>
                  </>
                )}
              </RootLink>
            </li>
          )
        })}
      </ul>
      {(recents?.length ?? 0) > 0 && (
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
            const label = `${title} — ${reasonText(reason)}${project ? ` · ${project}` : ""}`
            return (
              <li key={sessionId}>
                <RootLink
                  to={`/c/${sessionId}`}
                  onClick={onNavigate}
                  className={(state) => cn(rowClass(state), "py-2", collapsed && railRowClass)}
                  {...sidebarItemAccessibility(label, collapsed)}
                >
                  <Icon
                    className={cn(
                      "size-5 shrink-0 text-warning",
                      collapsed ? "self-center" : "self-start",
                    )}
                  />
                  {collapsed ? (
                    <span className="sr-only">{reasonText(reason)}</span>
                  ) : (
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

function ProfileButton({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
}) {
  const { account } = useSyncState()
  const picture = account.status === "signed-in" ? account.user.pictureUrl : undefined

  return (
    <RootLink
      to="/settings"
      onClick={onNavigate}
      aria-label="Settings"
      title={sidebarItemAccessibility("Settings", collapsed).title}
      className={({ isActive }) =>
        cn(
          "flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full text-muted-foreground transition-shadow",
          !collapsed && "bg-muted ring-1 ring-foreground/10",
          isActive && !collapsed && "ring-2 ring-foreground/40",
        )
      }
    >
      {collapsed ? (
        <SettingsIcon className="size-5" />
      ) : picture ? (
        <img src={picture} alt="" className="size-full object-cover" />
      ) : (
        <UserIcon className="size-5" />
      )}
    </RootLink>
  )
}

export function ConversationList({
  onNavigate,
  onToggleSidebar,
  collapsed = false,
}: {
  onNavigate?: () => void
  /** Fold/unfold the permanent sidebar; when given, its header shows the toggle. */
  onToggleSidebar?: () => void
  collapsed?: boolean
}) {
  const { root } = useNav()
  const research = useResearchEnabled()
  const newChat = () => {
    root("/")
    onNavigate?.()
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", collapsed && "w-full")}>
      <div className="flex items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-2">
        {!collapsed && (
          <span className="flex-1 pl-1 text-xl font-semibold tracking-tight">Memento</span>
        )}
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 rounded-full"
            aria-label="Search"
          >
            <SearchIcon />
          </Button>
        )}
        {onToggleSidebar && (
          <Button
            variant="ghost"
            size="icon-lg"
            className={cn("size-11 rounded-full", collapsed && "mx-auto")}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleSidebar}
          >
            {collapsed ? <ChevronRightIcon /> : <PanelLeftCloseIcon />}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          <RootLink
            to="/code"
            onClick={onNavigate}
            className={(state) => cn(rowClass(state), collapsed && railRowClass)}
            {...sidebarItemAccessibility("Code", collapsed)}
          >
            <CodeXmlIcon className="size-5 text-muted-foreground" />
            {!collapsed && "Code"}
          </RootLink>
          <RootLink
            to="/routines"
            onClick={onNavigate}
            className={(state) => cn(rowClass(state), collapsed && railRowClass)}
            {...sidebarItemAccessibility("Routines", collapsed)}
          >
            <TimerIcon className="size-5 text-muted-foreground" />
            {!collapsed && "Routines"}
          </RootLink>
          {research && (
            <RootLink to="/research" onClick={onNavigate} className={rowClass}>
              <TelescopeIcon className="size-5 text-muted-foreground" />
              Research
            </RootLink>
          )}
        </nav>
        <Separator className="mx-1 my-3 data-horizontal:w-auto" />
        <Waiting onNavigate={onNavigate} collapsed={collapsed} />
        <Recents onNavigate={onNavigate} collapsed={collapsed} />
      </div>

      <div
        className={cn(
          "flex items-center justify-between gap-3 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]",
          collapsed && "flex-col items-center gap-2 px-0",
        )}
      >
        <ProfileButton onNavigate={onNavigate} collapsed={collapsed} />
        {collapsed ? (
          <Button
            size="icon-lg"
            className="size-11 rounded-full"
            {...sidebarItemAccessibility("New chat", collapsed)}
            onClick={newChat}
          >
            <PlusIcon />
          </Button>
        ) : (
          <Button
            size="lg"
            className="h-11 rounded-full px-5"
            {...sidebarItemAccessibility("New chat", collapsed)}
            onClick={newChat}
          >
            <PlusIcon data-icon="inline-start" />
            New chat
          </Button>
        )}
      </div>
    </div>
  )
}
