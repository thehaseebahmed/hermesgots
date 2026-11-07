import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
import {
  useAppsPane,
  useCodePane,
  useMeetingsPane,
  useProjectsPane,
  useResearchPane,
} from "@/lib/pane"
import { useSidebarCollapsed } from "@/lib/sidebar"
import { useBotPane, useBotThreads, type BotLane } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { onChatSwap, type HoldSlot } from "@/lib/chat-hold"
import { PaneTransition } from "@/components/pane-transition"
import { ChatPage } from "@/routes/chat"

/**
 * A list kept on screen beside what it opened: a bot beside its thread (from `xl`), or Code's
 * sessions, the projects, the meetings, research missions or apps beside one (where `useSplit` says
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
  /** How the list takes its share of the row, and how an item arrives beside it. */
  layout: PaneLayout
}

/**
 * How a list and the item beside it share the row: the width the list keeps while an item is open,
 * whether an arriving item slides in from the right or the row rearranges instead, and where an item
 * that closes is held while the list takes the whole row.
 */
interface PaneLayout {
  /** The list's width class while an item is open. Closed, it takes the whole row. */
  list: string
  /** Whether an arriving item slides in 48px from the right, fading, as the list narrows. */
  slide: boolean
  /**
   * Where a closing item is held for the row's transition — its place and the share it had, the
   * complement of the list's — so it is clipped out by the list growing rather than squeezed or
   * dropped in the first frame. Nothing where an item leaves with its lane.
   */
  exit?: string
}

/** A list lane: Material 3's 412px, as in Settings, and the item sliding in beside it. */
const LIST_LANE: PaneLayout = { list: "w-103", slide: true }

/**
 * A bot's thread beside Main: the two chats take half of the room the sidebar leaves each. A
 * percentage of the row rather than a width, because the sidebar may be open or a rail and half is
 * right in both (ADR 0110). The row rearranges rather than sliding — the edge between the chats is
 * the one thing that moves — and a thread closing keeps its half until Main has covered it.
 */
const SPLIT_LANE: PaneLayout = { list: "w-1/2", slide: false, exit: "left-1/2 w-1/2" }

/**
 * The policy a bot's lane takes: split while its thread list has answered with a thread beside
 * Main, and the list lane for a bot with no thread, which keeps the rail that says so. A list still
 * to answer keeps the policy the answer before it gave the lane — unknown is not closed — so a
 * switch from one bot to the next never flashes Main wide and back.
 */
function useBotLaneLayout(lane: BotLane | undefined) {
  const [split, setSplit] = useState(false)
  const answered = lane && lane.state !== "unknown" ? lane.state === "thread" : undefined
  // Adjusted during render rather than in an effect, so a switch never draws the lane the bot it
  // left had, not even for a frame.
  if (answered !== undefined && answered !== split) setSplit(answered)
  return split ? SPLIT_LANE : LIST_LANE
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
const AppsPane = lazy(() => import("@/routes/apps").then((m) => ({ default: m.AppsPane })))
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
  exit?: string
}

/** The window a closing item is held for: the 300ms the lane's width transition runs on. */
const EXIT_MS = 300

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
        exit: layout?.exit,
      })
  }
  // A closing item keeps the place it had until the list has taken the row — clipped, inert and out
  // of reach rather than squeezed or dropped in the first frame. Reduced motion gets both states in
  // one frame: nothing is held, and the lane's transition is off in CSS.
  const [exit, setExit] = useState<HeldItem | undefined>(undefined)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setExit(
      open || !pane || held?.screen !== pane.screen || !held?.exit || prefersReducedMotion()
        ? undefined
        : held,
    )
  }
  useEffect(() => {
    if (!exit) return
    const timer = window.setTimeout(() => setExit(undefined), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [exit])
  useLayoutEffect(() => {
    if (!open || !layout?.slide || prefersReducedMotion()) return
    session.current?.animate(
      [
        { opacity: 0, transform: "translateX(48px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 300, easing: EASE },
    )
  }, [open, layout?.slide])

  return (
    <div className="relative flex min-h-0 flex-1">
      {pane && (
        <div
          data-slot="list-lane"
          className={cn(
            // Over the item it is taking back, so the edge moving is the thread being clipped out.
            `relative z-10 flex min-h-0 flex-none flex-col transition-[width] duration-300 ${EASE_CLASS} motion-reduce:transition-none`,
            open ? cn(pane.layout.list, "border-r") : "w-full",
          )}
        >
          <Suspense fallback={null}>{pane.node}</Suspense>
        </div>
      )}
      <div
        ref={session}
        data-slot="item-lane"
        inert={exit ? true : undefined}
        aria-hidden={exit ? true : undefined}
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          exit && "pointer-events-none absolute inset-y-0 overflow-hidden",
          exit?.exit,
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
  const apps = useAppsPane()
  // Keyed by the conversation it shows, so the thread the address names and the one this device
  // remembers are one pane when they are one chat: naming it in the address, or leaving it for
  // Main again, doesn't remount it. Main is the pane and is never drawn twice, so this holds the
  // thread the lane answers with, else nothing at all.
  const lane = bot?.lane
  const shown = lane?.state === "thread" ? lane.thread : undefined
  // Half the row while a thread stands beside Main, the list lane while there is none, and the
  // answer before it while this bot's thread list is still out.
  const botLayout = useBotLaneLayout(lane)
  // A lane that holds a thread can be put away from its own header, whether the address names that
  // thread or not: the move is the pane's, since it is the one that knows where its bot's Main is.
  const closeThread = bot?.canClose ? bot.close : undefined
  const botItem = shown ? (
    <ChatPage key={shown} chatId={shown} slot="thread" closeThread={closeThread} />
  ) : bot ? (
    <ThreadLane lane={bot.lane} />
  ) : undefined
  const pane: ListPane | undefined = bot
    ? {
        screen: `/c/${mainThreadId(bot.profileId)}`,
        // The lane says: open unless it is closed, so a switch never closes and reopens Main.
        open: bot.lane.state !== "closed",
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
          : research
            ? {
                screen: "/research",
                open: research.open,
                itemKey: research.selected,
                node: <ResearchPane pane={research} />,
                layout: LIST_LANE,
              }
            : apps && {
                screen: "/apps",
                open: apps.open,
                itemKey: apps.selected,
                node: <AppsPane pane={apps} />,
                layout: LIST_LANE,
              }
  usePageTransition(main, pane)

  return (
    <BreakReminderProvider>
      <KeyboardShortcuts closeThread={closeThread} />
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
