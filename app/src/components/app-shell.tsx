import {
  lazy,
  Suspense,
  useCallback,
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
import { botChatsPath } from "@/lib/bot-tabs"
import { useBubbleMirror, useBubbleTakeaways } from "@/lib/bubble"
import { prefersReducedMotion, useLarge, useWide } from "@/lib/media"
import { depth } from "@/lib/nav"
import {
  useBotChatsPane,
  useCodePane,
  useMeetingsPane,
  useProjectsPane,
  useResearchPane,
} from "@/lib/pane"
import { setMenuOpener } from "@/lib/native"
import { useSidebarCollapsed } from "@/lib/sidebar"
import { useLegacyChat } from "@/lib/legacy-chat"
import { cn } from "@/lib/utils"
import { onChatSwap, type HoldSlot } from "@/lib/chat-hold"
import { PaneTransition } from "@/components/pane-transition"

/**
 * A list kept on screen beside what it opened: a bot's chats beside the chat they opened, or Code's
 * sessions, the projects, the meetings, or research missions beside one (where `useSplit` says
 * there is room). `screen` is the list's own path.
 */
interface ListPane {
  screen: string
  open: boolean
  node: ReactNode
  /** The item open beside the list: when it changes, the item left fades out over the next. */
  itemKey?: string
}

/** A list lane: Material 3's 412px, as in Settings, and the item sliding in beside it. */
const LIST_LANE = "w-103"

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
const BotChatsPane = lazy(() =>
  import("@/routes/bot-chats").then((m) => ({ default: m.BotChatsPane })),
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
 * A list and the item open beside it: the list narrows to its lane and the item arrives at its
 * right, sliding in as the list narrows. Both stay mounted while items are swapped, so an item
 * leaving fades out over the one landing (`PaneTransition`) and the chrome they share never blinks.
 */
function Panes({ pane, children }: { pane: ListPane | undefined; children: ReactNode }) {
  const session = useRef<HTMLDivElement>(null)
  const open = Boolean(pane?.open)
  // The entrance is the lane's opening, and only that: a list already open — a chat switched in the
  // item pane beside it — must not replay the slide, so `open` alone is the dependency.
  useLayoutEffect(() => {
    if (!open || prefersReducedMotion()) return
    session.current?.animate(
      [
        { opacity: 0, transform: "translateX(48px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 300, easing: EASE },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` alone, as above
  }, [open])

  return (
    <div className="relative flex min-h-0 flex-1">
      {pane && (
        <div
          data-slot="list-lane"
          // Over the item it opened, so the edge moving is the item being taken in — and painted,
          // so the item it is covering is never drawn in the same pixels as the list's own words.
          // The page's own colour, so nothing moves when it lands.
          className={cn(
            "relative z-10 flex min-h-0 flex-none flex-col bg-background",
            `transition-[width] ${EASE_CLASS} motion-reduce:transition-none`,
            open ? cn(LIST_LANE, "border-r") : "w-full",
          )}
        >
          <Suspense fallback={null}>{pane.node}</Suspense>
        </div>
      )}
      <div ref={session} data-slot="item-lane" className="flex min-w-0 flex-1 flex-col">
        {/* A list's own route has nothing to add beside it. */}
        {!pane || open ? (
          <PaneTransition item={pane?.itemKey}>
            <Suspense fallback={null}>{children}</Suspense>
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
  const openDrawer = useCallback(() => setOpen(true), [])
  // The drawer is the phone's menu: where the sidebar stands, the menu is already on screen, so the
  // press at the app's edge offers nothing rather than a sheet over a list that is already there.
  useEffect(() => (wide ? undefined : setMenuOpener(openDrawer)), [openDrawer, wide])
  const [collapsed, toggleCollapsed] = useSidebarCollapsed()
  const { pathname } = useLocation()
  const main = useRef<HTMLElement>(null)
  // Code is asked first: a session's address is a chat's too, and the pane it belongs to is Code's
  // list, never the list of the bot that happens to hold its record (ADR 0115).
  const code = useCodePane()
  const bot = useBotChatsPane(useLegacyChat() === false)
  const projects = useProjectsPane()
  const meetings = useMeetingsPane()
  const research = useResearchPane()
  const pane: ListPane | undefined = code
    ? {
        screen: "/code",
        open: code.open,
        itemKey: code.selected,
        node: <CodePane pane={code} />,
      }
    : bot
      ? {
          screen: botChatsPath(bot.profileId),
          open: bot.open,
          itemKey: bot.selected,
          node: <BotChatsPane pane={bot} />,
        }
      : projects
        ? {
            screen: "/projects",
            open: projects.open,
            itemKey: projects.selected,
            node: <ProjectsPane pane={projects} />,
          }
        : meetings
          ? {
              screen: "/meetings",
              open: meetings.open,
              itemKey: meetings.selected,
              node: <MeetingsPane pane={meetings} />,
            }
          : research && {
              screen: "/research",
              open: research.open,
              itemKey: research.selected,
              node: <ResearchPane pane={research} />,
            }
  usePageTransition(main, pane)

  return (
    <BreakReminderProvider>
      <KeyboardShortcuts />
      <DrawerContext.Provider value={openDrawer}>
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
