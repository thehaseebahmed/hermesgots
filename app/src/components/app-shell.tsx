import {
  lazy,
  Suspense,
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
import { useLarge, useWide } from "@/lib/media"
import { depth } from "@/lib/nav"
import { useCodePane, useMeetingsPane, useProjectsPane, useResearchPane } from "@/lib/pane"
import { useSidebarCollapsed } from "@/lib/sidebar"
import { useBotPane, useBotThreads } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { onChatSwap, heldFrame, type HoldSlot } from "@/lib/chat-hold"
import { ChatPage } from "@/routes/chat"

/**
 * A list kept on screen beside what it opened: a bot beside its thread (from `xl`), or Code's
 * sessions, the projects, the meetings or research missions beside one (where `useSplit` says
 * there is room). `screen` is the list's own path, and `item` is an item the pane carries itself,
 * in place of the screen the route draws beside it.
 */
interface ListPane {
  screen: string
  open: boolean
  node: ReactNode
  item?: ReactNode
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
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
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
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
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
 * once the bot's thread list has answered. Until then it holds the frame the pane last drew, inert,
 * so neither the lane's place nor what it says moves while the answer is on its way.
 */
function ThreadLane({ threads }: { threads?: boolean }) {
  if (threads === false)
    return (
      <div
        data-slot="bot-pane-empty"
        className="flex min-h-0 flex-1 items-center justify-center px-6 text-center"
      >
        <p className="text-sm text-muted-foreground">No threads yet</p>
      </div>
    )
  const held = threads === undefined ? heldFrame("thread") : undefined
  if (!held?.frame) return null
  // The same box `ChatPage` draws a held pane in, so the frame is the pane it was, and inert, so
  // nothing in a chat the pane has left can be tapped.
  return (
    <div
      data-slot="chat-pane"
      data-pane="thread"
      className="relative flex min-h-0 flex-1 flex-col"
      inert
    >
      {held.frame}
    </div>
  )
}

/**
 * A list and the item open beside it: the list narrows to a pane and the item slides in to its
 * right. Both stay mounted while items are swapped.
 */
function Panes({ pane, children }: { pane: ListPane | undefined; children: ReactNode }) {
  const session = useRef<HTMLDivElement>(null)
  const open = Boolean(pane?.open)
  useLayoutEffect(() => {
    if (!open || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    session.current?.animate(
      [
        { opacity: 0, transform: "translateX(48px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 300, easing: EASE },
    )
  }, [open])

  return (
    <div className="flex min-h-0 flex-1">
      {pane && (
        <div
          className={cn(
            `flex min-h-0 flex-none flex-col transition-[width] duration-300 ${EASE_CLASS} motion-reduce:transition-none`,
            // Material 3's list pane width, as in Settings.
            open ? "w-103 border-r" : "w-full",
          )}
        >
          <Suspense fallback={null}>{pane.node}</Suspense>
        </div>
      )}
      <div ref={session} className="flex min-w-0 flex-1 flex-col">
        {/* A list's own route has nothing to add beside it. */}
        {pane && !open ? null : <Suspense fallback={null}>{pane?.item ?? children}</Suspense>}
      </div>
    </div>
  )
}

export function AppShell({ children }: { children?: ReactNode }) {
  const wide = useWide()
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
  // address's thread, else the last opened, else nothing at all.
  const shown = bot && (bot.thread ?? bot.last)
  const botItem = shown ? (
    <ChatPage key={shown} chatId={shown} slot="thread" />
  ) : bot ? (
    <ThreadLane threads={bot.threads} />
  ) : undefined
  const pane: ListPane | undefined = bot
    ? {
        screen: `/c/${mainThreadId(bot.profileId)}`,
        // Open while the bot has a thread to show, or while its thread list has yet to say it has
        // none: a lane that closed and reopened would move Main twice for one switch.
        open: Boolean(bot.thread || bot.last || bot.threads !== true),
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
      }
    : code
      ? { screen: "/code", open: code.open, node: <CodePane pane={code} /> }
      : projects
        ? { screen: "/projects", open: projects.open, node: <ProjectsPane pane={projects} /> }
        : meetings
          ? { screen: "/meetings", open: meetings.open, node: <MeetingsPane pane={meetings} /> }
          : research && {
              screen: "/research",
              open: research.open,
              node: <ResearchPane pane={research} />,
            }
  usePageTransition(main, pane)

  return (
    <BreakReminderProvider>
      <KeyboardShortcuts />
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
