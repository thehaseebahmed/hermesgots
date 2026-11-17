import { useLiveQuery } from "dexie-react-hooks"
import { Link, matchPath, NavLink, useLocation, type NavLinkProps } from "react-router"
import {
  AudioLinesIcon,
  BellOffIcon,
  CodeXmlIcon,
  FolderKanbanIcon,
  ListChecksIcon,
  FrameIcon,
  MessageCircleQuestionMarkIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  ShieldAlertIcon,
  TelescopeIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react"

import { Bot } from "@/components/bot"
import { CanvasMark } from "@/components/canvas-mark"
import { LabLabel } from "@/components/lab-badge"
import { SortMenu } from "@/components/sort-menu"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { botMainPath } from "@/lib/bot-tabs"
import { stateLine } from "@/lib/bot-chrome"
import { closeCanvas, useCanvasOpened } from "@/lib/canvas-open"
import { useCanvasEnabled, usePinnedCanvases, type Canvas } from "@/lib/canvases"
import { chatOwner } from "@/lib/chat-owner"
import { db } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { useMeetingsEnabled } from "@/lib/meetings"
import { plainPress, pressOpeningRoot, useNav } from "@/lib/nav"
import {
  sidebarRows,
  type SidebarFeatureId,
  type SidebarLayoutRow,
  type SidebarLab,
} from "@/lib/sidebar-layout"
import { useSyncState } from "@/lib/sync"
import { BOT_SORTS, sortBots, useBotSort, useBotSummaries, useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { reasonText, useWaitingSessions, type WaitingReason } from "@/lib/waiting"

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

/**
 * A sidebar destination: top-level, so it opens as the only entry and back leaves the app.
 */
function RootLink({
  to,
  onClick,
  ...props
}: NavLinkProps & { to: string } & Record<`data-${string}`, string | undefined>) {
  const { root } = useNav()
  return <NavLink to={to} replace onClick={pressOpeningRoot(root, to, onClick)} {...props} />
}

const REASON_ICONS: Record<WaitingReason["kind"], typeof ListChecksIcon> = {
  question: MessageCircleQuestionMarkIcon,
  approval: ShieldAlertIcon,
  plan: ListChecksIcon,
  stalled: TriangleAlertIcon,
}

/** A row's age, in the one voice every list that draws one uses. */
function RowAge({ at, now }: { at: number; now: number }) {
  return (
    <span className="shrink-0 text-xs font-normal text-muted-foreground">
      {formatRelative(at, now)}
    </span>
  )
}

/**
 * Each feature's mark, by the id the table files it under. Typed by those ids, so a feature added to
 * the table without an icon here fails `pnpm typecheck` rather than drawing a row with no mark.
 */
const FEATURE_ICONS: Record<SidebarFeatureId, typeof FolderKanbanIcon> = {
  projects: FolderKanbanIcon,
  code: CodeXmlIcon,
  canvas: FrameIcon,
  research: TelescopeIcon,
  meetings: AudioLinesIcon,
}

/**
 * One row of the sidebar's list, drawn from the table (`lib/sidebar-layout.ts`) — a feature's screen,
 * or the canvas the reader pinned. A pin's own body is `CanvasRow`, since a pin is marked by the tab
 * that opened it and not by its address, and the table's row is all either kind has in common.
 */
function SidebarRow({
  row,
  collapsed,
  onNavigate,
}: {
  row: SidebarLayoutRow<Canvas>
  collapsed: boolean
  onNavigate?: () => void
}) {
  if (row.kind === "pin")
    return <CanvasRow canvas={row.pin} collapsed={collapsed} onNavigate={onNavigate} />
  const Icon = FEATURE_ICONS[row.id]
  return (
    <RootLink
      to={row.address}
      end={row.end}
      onClick={onNavigate}
      aria-label={collapsed ? row.label : undefined}
      className={collapsed ? railClass : rowClass}
    >
      <Icon className="size-5 text-muted-foreground" />
      {/* The pill says what the row's `lab` reports: the rows a switch can take away are the lab's. */}
      {!collapsed && (row.lab ? <LabLabel fill>{row.label}</LabLabel> : row.label)}
    </RootLink>
  )
}

/**
 * A pinned canvas's row. No `NavLink`: the canvas this tab opened marks it, not the address
 * (`lib/canvas-open.ts`, ADR 0151).
 */
function CanvasRow({
  canvas,
  collapsed,
  onNavigate,
}: {
  canvas: Canvas
  collapsed: boolean
  onNavigate?: () => void
}) {
  const { root } = useNav()
  const to = `/canvas/${canvas.id}`
  const opened = useCanvasOpened(canvas.id)
  return (
    <Link
      to={to}
      replace
      onClick={pressOpeningRoot(root, to, (event) => {
        onNavigate?.()
        // A row's press is a way onto the canvas like any other and no open, so the mark the flow
        // wrote goes with it (ADR 0151) — a press meant for a new tab leaves this tab as it was.
        if (plainPress(event)) closeCanvas()
      })}
      aria-label={collapsed ? canvas.title : undefined}
      aria-current={opened ? "page" : undefined}
      data-canvas-pinned=""
      className={(collapsed ? railClass : rowClass)({ isActive: opened })}
    >
      <CanvasMark mark={canvas.mark} />
      {!collapsed && <span className="min-w-0 truncate">{canvas.title}</span>}
    </Link>
  )
}

/**
 * Every bot that's turned on, each with the line saying its state — something unread, or whether its
 * host is checking in (ADR 0151) — and a press that opens the bot on its **Main**.
 *
 * The sidebar draws no chat list of its own: a bot's conversations are that bot's screens, one press
 * in (ADR 0161), so the Host's rooms are rows of the bot's own lists rather than a section here. A room
 * its roster seats still counts toward that bot's unread (ADR 0151).
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
  // What this device's last chat-list pass answered for each bot: the whole evidence behind the
  // line's Online or Offline.
  const { chatStores } = useSyncState()

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
        {bots?.map(({ bot, label, latest, unread }) => {
          const age = latest?.updatedAt
          return (
            <li key={bot.id}>
              {/* A bot's row is the design's row for a title with a line under it, not the menu's
                  44px one: a 36px picture and two lines leave a 44px row no air, and draw the
                  picture against its top edge (ADR 0153, amended 2026-11-14). */}
              <RootLink
                to={botMainPath(bot.id)}
                onClick={onNavigate}
                aria-label={collapsed ? label : undefined}
                className={({ isActive }) =>
                  collapsed
                    ? railClass({ isActive: isActive || owner === bot.id })
                    : cn(rowClass({ isActive: isActive || owner === bot.id }), "min-h-14 py-2")
                }
              >
                <span className="relative flex shrink-0">
                  <Bot id={bot.botId} className="size-9" />
                  {/* The rail draws no line under the name, so its mark is the only one a row has
                      there: news since this device last looked at one of the bot's conversations
                      (ADR 0110, ADR 0151). */}
                  {collapsed && unread > 0 && (
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
                      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                      {bot.muted && (
                        <BellOffIcon
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-label="Muted"
                        />
                      )}
                      {age && <RowAge at={age} now={now} />}
                    </span>
                    {/* Drawn, never read out: the line beside it already counts what it marks
                        (ADR 0151). */}
                    <span className="flex items-center gap-2">
                      <span
                        data-slot="bot-state"
                        className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground"
                      >
                        {stateLine({
                          unread,
                          bot,
                          now,
                          answer: chatStores[bot.id],
                        })}
                      </span>
                      {unread > 0 && (
                        <span
                          data-unread
                          aria-hidden
                          className="dot-glow size-2.5 shrink-0 rounded-full bg-warning"
                        />
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
                    collapsed ? railClass(state) : cn(rowClass(state), "min-h-14 py-2")
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

/**
 * The app's sidebar: the screens that are places, the sessions waiting on the reader, and every bot
 * with its state. It draws no chat list of its own — a bot's conversations are that bot's screens,
 * one press in (ADR 0161) — and no New chat, since a chat is started from the list it belongs to.
 */
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
  const meetings = useMeetingsEnabled()
  const canvas = useCanvasEnabled()
  // A switch this device has not answered yet draws no row: `undefined` is no yes.
  const gates: Record<SidebarLab, boolean> = {
    canvas: canvas === true,
    meetings: meetings === true,
  }
  // The pins are read only under Canvas's switch, so a build with Canvas off refreshes nothing; which
  // rows are drawn is the table's gate below, one decision for every row alike.
  const pinned = usePinnedCanvases(gates.canvas)
  const rows = sidebarRows(pinned).filter((row) => row.lab === null || gates[row.lab])

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
          {rows.map((row) => (
            <SidebarRow key={row.id} row={row} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </nav>
        <Separator className="mx-1 my-3 data-horizontal:w-auto" />
        <Waiting onNavigate={onNavigate} collapsed={collapsed} />
        <Bots onNavigate={onNavigate} collapsed={collapsed} />
      </div>

      <div
        className={cn(
          "flex items-center px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]",
          collapsed && "justify-center px-2",
        )}
      >
        <ProfileButton onNavigate={onNavigate} />
      </div>
    </div>
  )
}
