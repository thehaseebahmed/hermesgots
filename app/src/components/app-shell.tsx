import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as KeyEvent,
  type PointerEvent as Pointer,
  type ReactNode,
  type RefObject,
} from "react"
import { Outlet, matchPath, useLocation, useNavigationType } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { BreakReminderProvider } from "@/components/break-reminder-provider"
import { CrashBoundary } from "@/components/crash-screen"
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts"
import { DrawerContext } from "@/components/drawer-context"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { mainThreadId } from "@/lib/db"
import { useBubbleMirror, useBubbleTakeaways } from "@/lib/bubble"
import { prefersReducedMotion, useLarge, useWide } from "@/lib/media"
import { depth } from "@/lib/nav"
import { useCodePane, useMeetingsPane, useProjectsPane, useResearchPane } from "@/lib/pane"
import { useSidebarCollapsed } from "@/lib/sidebar"
import {
  readSplit,
  shareAt,
  shareKept,
  SPLIT_HALF,
  SPLIT_STEP,
  SPLIT_STEP_FAST,
  splitWidth,
  writeSplit,
} from "@/lib/split"
import { useBotPane, useBotThreads, type BotLane } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { onChatSwap, type HoldSlot } from "@/lib/chat-hold"
import { PaneTransition } from "@/components/pane-transition"
import { ChatPage } from "@/routes/chat"

/**
 * A list kept on screen beside what it opened: a bot beside its thread (from `xl`), or Code's
 * sessions, the projects, the meetings, or research missions beside one (where `useSplit` says
 * there is room). `screen` is the list's own path, and `item` is an item the pane carries itself,
 * in place of the screen the route draws beside it.
 */
interface ListPane {
  screen: string
  open: boolean
  node: ReactNode
  item?: ReactNode
  /** The item open beside the list: when it changes, the item left fades out over the next. */
  itemKey?: string
  layout: PaneLayout
}

/**
 * How a list and the item beside it share the row: the width the list keeps while an item is open,
 * whether the reader drags the edge between them and what that edge is called, and whether an
 * arriving item slides in from the right or the row rearranges instead.
 */
interface PaneLayout {
  /** The list's width class while an item is open. Closed, it takes the whole row. */
  list?: string
  /**
   * The share of the row is the reader's to drag — floored at `SPLIT_FLOOR` a side, and written as
   * the width itself rather than a class, since no class can hold a dragged share — with the name
   * the separator carries. The words belong to the lane that owns the two chats: `Panes` is generic
   * and knows neither of them, so a later lane can never inherit another's name.
   */
  split?: { handle: string }
  /** Whether an arriving item slides in 48px from the right, fading, as the list narrows. */
  slide: boolean
}

/** A list lane: Material 3's 412px, as in Settings, and the item sliding in beside it. */
const LIST_LANE: PaneLayout = { list: "w-103", slide: true }

/**
 * A bot's thread beside Main: the two chats share the room the sidebar leaves, and the reader drags
 * the edge between them. A fraction of the row rather than a width, because the sidebar may be open
 * or a rail and half is right in both, and each chat floored at 412px by a CSS clamp, so shrinking
 * the window can never crush Main and nothing has to listen for a resize (ADR 0113). The row
 * rearranges rather than sliding — the edge between the chats is the one thing that moves — and a
 * thread closing keeps its share until Main has covered it.
 */
const SPLIT_LANE: PaneLayout = {
  split: { handle: "Resize Main and the thread" },
  slide: false,
}

/**
 * How the shell draws a bot's lane, as the lane's own states: a thread beside Main (the split), no
 * threads at all (the rail that says so), or Main alone at the row's whole width.
 */
type LanePolicy = "thread" | "empty" | "closed"

/**
 * The state a bot's thread list last answered with, kept through the next bot's unanswered list —
 * the whole policy, not just which layout, because a closed lane that fell back to "open" would
 * flash the 412px rail on its way to Main's whole width. Only a real answer moves it, so a switch
 * from one bot to the next draws the state and the width the lane had until the answer lands.
 */
function useLanePolicy(lane: BotLane | undefined): LanePolicy {
  const [answered, setAnswered] = useState<LanePolicy>("empty")
  // Adjusted during render rather than in an effect, so a switch never draws the lane the bot it
  // left had, not even for a frame.
  if (lane && lane.state !== "unknown" && lane.state !== answered) setAnswered(lane.state)
  return lane && lane.state !== "unknown" ? lane.state : answered
}

/**
 * From `lg` Settings' sections open beside its menu, and a list and what it opened beside it, so
 * each counts as one screen.
 */
function screenOf(path: string, large: boolean, pane: ListPane | undefined) {
  if (pane) return pane.screen
  return large && path.startsWith("/settings") ? "/settings" : path
}

const MeetingsPane = lazy(() =>
  import("@/routes/meetings").then((m) => ({ default: m.MeetingsPane })),
)
const ResearchPane = lazy(() =>
  import("@/routes/research").then((m) => ({ default: m.ResearchPane })),
)
const CodePane = lazy(() => import("@/routes/code").then((m) => ({ default: m.CodePane })))
const ProjectsPane = lazy(() =>
  import("@/routes/projects").then((m) => ({ default: m.ProjectsPane })),
)

function chatOf(screen: string) {
  const chat = matchPath("/c/:id", screen)?.params.id
  if (chat) return chat
  return screen === "/" ? "" : undefined
}

function isChatSwitch(from: string, to: string) {
  const before = chatOf(from)
  const after = chatOf(to)
  return before !== undefined && after !== undefined && before !== after
}

const EASE = "cubic-bezier(0.2, 0, 0, 1)"
const EASE_CLASS = "ease-[cubic-bezier(0.2,0,0,1)]"
const FADE_MS = 200
const FADE: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }]

/**
 * Animates the main pane in when the screen changes: from the right when it was opened on top of
 * the last one, from the left when going back to it, and a fade when it took the last one's place.
 */
function usePageTransition(ref: RefObject<HTMLElement | null>, pane: ListPane | undefined) {
  const location = useLocation()
  const type = useNavigationType()
  const large = useLarge()
  const screen = screenOf(location.pathname, large, pane)
  const last = useRef({ screen, idx: depth(), key: location.key })
  const faded = useRef(new Map<HoldSlot, string>())

  useLayoutEffect(() => {
    const previous = last.current
    last.current = { screen, idx: depth(), key: location.key }
    if (last.current.screen === previous.screen) return
    // A session found to belong to a project once it loads: it was animated as it opened.
    if (location.key === previous.key) return
    // A new chat taking its id once the first message is sent stays the same screen.
    if (type === "REPLACE" && (location.state as { quiet?: boolean } | null)?.quiet) return
    if (isChatSwitch(previous.screen, screen)) return
    if (prefersReducedMotion()) return
    const step = Math.sign(last.current.idx - previous.idx)
    ref.current?.animate(
      step
        ? [
            { opacity: 0, transform: `translateX(${step * 24}px)` },
            { opacity: 1, transform: "none" },
          ]
        : FADE,
      { duration: step ? 260 : FADE_MS, easing: EASE },
    )
  }, [location, type, screen, ref])

  useLayoutEffect(
    () =>
      onChatSwap((slot) => {
        if (faded.current.get(slot) === location.key) return
        faded.current.set(slot, location.key)
        if (prefersReducedMotion()) return
        document.querySelector<HTMLElement>(`[data-pane="${slot}"]`)?.animate(FADE, {
          duration: FADE_MS,
          easing: EASE,
        })
      }),
    [location.key],
  )
}

/**
 * The third pane of a bot that has no thread to keep beside Main. It stands at the pane's own width
 * so the layout doesn't move when the bot's first thread opens, and says the one thing it knows —
 * once the bot's thread list has answered. Until then it draws nothing, never the previous bot's
 * thread.
 */
function ThreadLane({ lane }: { lane: BotLane }) {
  if (lane.state !== "empty") return null
  return (
    <div
      data-slot="bot-pane-empty"
      className="flex min-h-0 flex-1 items-center justify-center px-6 text-center"
    >
      <p className="text-sm text-muted-foreground">No threads yet</p>
    </div>
  )
}

/**
 * The item a lane holds, kept with the key it is drawn by and the place its own lane holds it in
 * while the list takes the row. The screen is the pane's, so an item can never be held over a lane
 * that is not the one it was in.
 */
interface HeldItem {
  screen: string
  node: ReactNode
  key: string
  /** Whether the lane it was held in is the split, whose place is the share the reader left it at. */
  split?: boolean
  /** The box it keeps while the list covers it: its share of the row, set at the close. */
  exit?: CSSProperties
}

/** The window a closing item is held for: the lane's own width transition, one number, so the held
 * chat can neither be dropped early nor linger after the lane has stopped moving. */
const EXIT_MS = 300

/**
 * The box a closing item keeps in a split lane: the share its list has, the exact complement of the
 * list's width, so the thread is clipped out by Main growing rather than squeezed or dropped.
 */
function exitBox(share: number): CSSProperties {
  const width = splitWidth(share)
  return { left: width, width: `calc(100% - ${width})` }
}

/**
 * The edge between the two chats, as a control: a separator a reader drags, nudges with the arrow
 * keys and puts back to half with Enter, Home or a double-click. A drag captures the pointer, follows
 * it with no transition — 300ms on every frame is a lag — and keeps the share on this device when the
 * pointer lifts; a key moves it and keeps it at once. Every way of moving the edge asks the same
 * rule, the row it is drawn in, so the share reported, stored and drawn is one number. Its name
 * comes from the lane that owns the two chats, since this one knows neither.
 */
function SplitHandle({
  label,
  share,
  width,
  dragging,
  onDrag,
  onShare,
  onKeep,
}: {
  label: string
  share: number
  width: string
  dragging: boolean
  onDrag: (dragging: boolean) => void
  onShare: (share: number) => void
  onKeep: (share: number) => void
}) {
  const rowOf = (edge: Element) => edge.parentElement?.getBoundingClientRect()
  const moveTo = (edge: HTMLElement, x: number) => {
    const row = rowOf(edge)
    if (row?.width) onShare(shareAt(x, row))
  }
  return (
    <div
      data-slot="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      style={{ left: width }}
      className={cn(
        "absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none",
        "hover:bg-ring/20 focus-visible:bg-ring/30",
        dragging && "bg-ring/30",
      )}
      onPointerDown={(event: Pointer<HTMLDivElement>) => {
        if (event.button !== 0) return
        // The pointer is the drag's for the whole gesture, however far past the edge it goes.
        event.currentTarget.setPointerCapture?.(event.pointerId)
        event.currentTarget.focus()
        onDrag(true)
        moveTo(event.currentTarget, event.clientX)
      }}
      // Eats the gesture's default so no transcript is selected and no native drag starts under it.
      onMouseDown={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      onPointerMove={(event: Pointer<HTMLDivElement>) => {
        if (dragging) moveTo(event.currentTarget, event.clientX)
      }}
      onPointerUp={(event: Pointer<HTMLDivElement>) => {
        if (!dragging) return
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        const row = rowOf(event.currentTarget)
        onDrag(false)
        onKeep(row?.width ? shareAt(event.clientX, row) : share)
      }}
      onPointerCancel={() => onDrag(false)}
      onKeyDown={(event: KeyEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? SPLIT_STEP_FAST : SPLIT_STEP
        const row = rowOf(event.currentTarget)
        if (event.key === "ArrowLeft") onKeep(shareKept(share - step, row?.width))
        else if (event.key === "ArrowRight") onKeep(shareKept(share + step, row?.width))
        else if (event.key === "Enter" || event.key === "Home") onKeep(SPLIT_HALF)
        else return
        event.preventDefault()
      }}
      onDoubleClick={() => onKeep(SPLIT_HALF)}
    />
  )
}

/**
 * A list and the item open beside it: the list narrows to its lane and the item arrives at its
 * right — sliding in unless the pane's layout says the row rearranges instead. Both stay mounted
 * while items are swapped, and an item whose lane clips it out is held at the share it had for that
 * window rather than vanishing with the close: the one number that animates is the lane's.
 */
function Panes({ pane, children }: { pane: ListPane | undefined; children: ReactNode }) {
  const session = useRef<HTMLDivElement>(null)
  const open = Boolean(pane?.open)
  const layout = pane?.layout
  const split = layout?.split
  // The share of the row the list keeps while a reader has dragged it: this device's, read the way
  // a launch reads it, and the one number the lane's width, the handle and the closing item's box
  // all stand on.
  const [share, setShare] = useState(readSplit)
  // A pointer drag follows the pointer with no transition at all: 300ms on every frame is a lag.
  const [dragging, setDragging] = useState(false)
  const width = split ? splitWidth(share) : undefined
  // The item the lane holds, remembered while it is open: by the frame the lane closes, the item and
  // the policy are already the closed lane's. State rather than a ref, adjusted during render, so
  // the value the close reads is the one this render committed.
  const [held, setHeld] = useState<HeldItem | undefined>(undefined)
  if (open && pane && pane.itemKey && pane.item !== undefined) {
    if (held?.key !== pane.itemKey || held?.screen !== pane.screen)
      setHeld({
        screen: pane.screen,
        node: pane.item,
        key: pane.itemKey,
        split: Boolean(split),
      })
  }
  // A closing item keeps the place it had until the list has taken the row — clipped, inert and out
  // of reach rather than squeezed or dropped in the first frame. Reduced motion gets both states in
  // one frame: nothing is held, and the lane's transition is off in CSS.
  const [exit, setExit] = useState<HeldItem | undefined>(undefined)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    const box = held?.split ? exitBox(share) : undefined
    setExit(
      open || !pane || held?.screen !== pane.screen || !box || prefersReducedMotion()
        ? undefined
        : { ...held, exit: box },
    )
  }
  useEffect(() => {
    if (!exit) return
    const timer = window.setTimeout(() => setExit(undefined), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [exit])
  // A drag lives on the handle: a gesture whose handle goes away mid-drag — Escape putting the lane
  // away, or the lane stopping being a split — never gets its pointerup, and a drag left standing
  // would hold the lane's width transition off for the rest of the session. Put down with the
  // handle, adjusted during render, so the frame that draws the lane without one draws it without
  // the drag too.
  const handleShown = split !== undefined && open
  const [wasHandle, setWasHandle] = useState(handleShown)
  if (wasHandle !== handleShown) {
    setWasHandle(handleShown)
    if (!handleShown) setDragging(false)
  }
  // The entrance is the lane's opening, and only that: a lane that opened without a slide — a bot's
  // thread beside Main — must not replay one later because the policy beside it slides, so the
  // policy is read here rather than watched, and `open` alone is the dependency.
  useLayoutEffect(() => {
    if (!open || !layout?.slide || prefersReducedMotion()) return
    session.current?.animate(
      [
        { opacity: 0, transform: "translateX(48px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 300, easing: EASE },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` alone, as above
  }, [open])

  // Where a key, a double-click or a drag's release leaves the edge: drawn at once, and kept on this
  // device so a reload, a close and a launch all find the same share. The handle has already kept
  // the share to what the row can draw.
  const keep = (next: number) => {
    setShare(next)
    writeSplit(next)
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      {pane && (
        <div
          data-slot="list-lane"
          // The lane's width transition is the same window the closing item is held for: one number,
          // so the chat held can't be dropped early or outlive the lane it was in.
          style={{
            ...(open && width ? { width } : undefined),
            transitionDuration: `${EXIT_MS}ms`,
          }}
          className={cn(
            // Over the item it is taking back, so the edge moving is the thread being clipped out —
            // and painted, so the thread it is covering is never drawn in the same pixels as Main's
            // own words. The page's own colour, so nothing moves when it lands.
            "relative z-10 flex min-h-0 flex-none flex-col bg-background",
            // The transition is the lane's own, and a pointer drag has none: it would trail by 300ms.
            !dragging && `transition-[width] ${EASE_CLASS} motion-reduce:transition-none`,
            open ? cn(pane.layout.list, "border-r") : "w-full",
          )}
        >
          <Suspense fallback={null}>{pane.node}</Suspense>
        </div>
      )}
      {handleShown && width && (
        <SplitHandle
          label={split.handle}
          share={share}
          width={width}
          dragging={dragging}
          onDrag={setDragging}
          onShare={setShare}
          onKeep={keep}
        />
      )}
      <div
        ref={session}
        data-slot="item-lane"
        inert={exit ? true : undefined}
        aria-hidden={exit ? true : undefined}
        style={exit?.exit}
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          exit && "pointer-events-none absolute inset-y-0 overflow-hidden",
        )}
      >
        {/* A list's own route has nothing to add beside it. */}
        {exit || !pane || open ? (
          <PaneTransition item={exit ? exit.key : pane?.itemKey}>
            <Suspense fallback={null}>{exit ? exit.node : (pane?.item ?? children)}</Suspense>
          </PaneTransition>
        ) : null}
      </div>
    </div>
  )
}

export function AppShell({ children }: { children?: ReactNode }) {
  const wide = useWide()
  useBubbleMirror()
  useBubbleTakeaways()
  const [open, setOpen] = useState(false)
  const [collapsed, toggleCollapsed] = useSidebarCollapsed()
  const { pathname } = useLocation()
  const main = useRef<HTMLElement>(null)
  const bot = useBotPane(useBotThreads())
  const code = useCodePane()
  const projects = useProjectsPane()
  const meetings = useMeetingsPane()
  const research = useResearchPane()
  // Keyed by the conversation it shows, so the thread the address names and the one this device
  // remembers are one pane when they are one chat: naming it in the address, or leaving it for
  // Main again, doesn't remount it. Main is the pane and is never drawn twice, so this holds the
  // thread the lane answers with, else nothing at all.
  const lane = bot?.lane
  const shown = lane?.state === "thread" ? lane.thread : undefined
  // The state the lane last answered with, which an unanswered list keeps: a closed lane stays
  // closed and a split lane stays split until the bot it is showing has answered (ADR 0113).
  const policy = useLanePolicy(lane)
  const botLayout = policy === "thread" ? SPLIT_LANE : LIST_LANE
  // A lane that holds a thread can be put away from its own header, the way an open one can be
  // asked for by the chord: the move is the pane's, since it is the one that knows where its bot's
  // Main is, and it is handed down only where the lane really holds a thread.
  const closeThread = lane?.state === "thread" ? bot?.close : undefined
  // The chord puts back what a close took away, so it is handed down only where that is the lane's
  // state: closed on this bot's Main, with a thread this visit closed. An open lane, a bot with no
  // thread to put back, or another bot's Main stands the key down, and the pane forgets a close the
  // moment the address leaves the bot it was made on.
  const reopenThread = lane?.state === "closed" ? bot?.reopen : undefined
  const botItem = shown ? (
    <ChatPage key={shown} chatId={shown} slot="thread" closeThread={closeThread} />
  ) : bot ? (
    <ThreadLane lane={bot.lane} />
  ) : undefined
  const pane: ListPane | undefined = bot
    ? {
        screen: `/c/${mainThreadId(bot.profileId)}`,
        // Main's whole width while the lane is closed — including while the bot it is switching to
        // has yet to answer, so a closed lane never reopens itself on the way.
        open: policy !== "closed",
        // Main is told what the third pane holds, so its own flow can mark that thread open.
        node: (
          <ChatPage
            key={bot.profileId}
            chatId={mainThreadId(bot.profileId)}
            paneThread={shown}
            slot="main"
          />
        ),
        item: botItem,
        itemKey: shown,
        layout: botLayout,
      }
    : code
      ? {
          screen: "/code",
          open: code.open,
          itemKey: code.selected,
          node: <CodePane pane={code} />,
          layout: LIST_LANE,
        }
      : projects
        ? {
            screen: "/projects",
            open: projects.open,
            itemKey: projects.selected,
            node: <ProjectsPane pane={projects} />,
            layout: LIST_LANE,
          }
        : meetings
          ? {
              screen: "/meetings",
              open: meetings.open,
              itemKey: meetings.selected,
              node: <MeetingsPane pane={meetings} />,
              layout: LIST_LANE,
            }
          : research && {
              screen: "/research",
              open: research.open,
              itemKey: research.selected,
              node: <ResearchPane pane={research} />,
              layout: LIST_LANE,
            }
  usePageTransition(main, pane)

  return (
    <BreakReminderProvider>
      <KeyboardShortcuts closeThread={closeThread} reopenThread={reopenThread} />
      <DrawerContext.Provider value={() => setOpen(true)}>
        <div className="flex h-dvh overflow-hidden bg-background">
          {/* Not mounted on phones, where the drawer holds the list, so its queries don't run twice. */}
          {wide && (
            <aside
              className={cn(
                `shrink-0 border-r bg-sidebar text-sidebar-foreground transition-[width] duration-300 ${EASE_CLASS} motion-reduce:transition-none`,
                collapsed ? "w-20" : "w-72 lg:w-80",
              )}
            >
              <ConversationList collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
            </aside>
          )}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="left" className="w-[85vw] max-w-80 p-0" showCloseButton={false}>
              <SheetTitle className="sr-only">Conversations</SheetTitle>
              <ConversationList onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <main ref={main} className="flex min-w-0 flex-1 flex-col overflow-x-clip">
            <CrashBoundary resetKey={pathname} menu>
              <Panes pane={pane}>{children ?? <Outlet />}</Panes>
            </CrashBoundary>
          </main>
        </div>
      </DrawerContext.Provider>
    </BreakReminderProvider>
  )
}
