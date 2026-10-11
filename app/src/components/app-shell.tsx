import type { CSSProperties } from "react"
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { Outlet, useLocation, useNavigationType } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { CrashBoundary } from "@/components/crash-screen"
import { DrawerContext } from "@/components/drawer-context"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useLarge } from "@/lib/media"
import { depth } from "@/lib/nav"
import { useProjectPane } from "@/lib/pane"
import { loadSidebarCollapsed, saveSidebarCollapsed, sidebarWidth } from "@/lib/sidebar"
import { useBotPane, useBotThreads } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { BotThreadsPage } from "@/routes/bot-threads"
import { ProjectPage } from "@/routes/project"

/**
 * A list kept on screen, from `xl`, beside what it opened: a project beside its session, or a bot
 * beside its thread. `screen` is the list's own path.
 */
interface ListPane {
  screen: string
  open: boolean
  node: ReactNode
}

/**
 * From `lg` Settings' sections open beside its menu, and from `xl` a project's sessions beside the
 * project (and a bot's threads beside the bot), so each counts as one screen.
 */
function screenOf(path: string, large: boolean, pane: ListPane | undefined) {
  if (pane) return pane.screen
  return large && path.startsWith("/settings") ? "/settings" : path
}

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

  useLayoutEffect(() => {
    const previous = last.current
    last.current = { screen, idx: depth(), key: location.key }
    if (last.current.screen === previous.screen) return
    // A session found to belong to a project once it loads: it was animated as it opened.
    if (location.key === previous.key) return
    // A new chat taking its id once the first message is sent stays the same screen.
    if (type === "REPLACE" && (location.state as { quiet?: boolean } | null)?.quiet) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const step = Math.sign(last.current.idx - previous.idx)
    ref.current?.animate(
      step
        ? [
            { opacity: 0, transform: `translateX(${step * 24}px)` },
            { opacity: 1, transform: "none" },
          ]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration: step ? 260 : 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    )
  }, [location, type, screen, ref])
}

/**
 * From `xl`, a project and the session open beside it: the project narrows to a list pane and the
 * session slides in to its right. Both stay mounted while sessions are swapped.
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
      { duration: 300, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    )
  }, [open])

  return (
    <div className="flex min-h-0 flex-1">
      {pane && (
        <div
          className={cn(
            "flex min-h-0 flex-none flex-col transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
            // Material 3's list pane width, as in Settings.
            open ? "w-103 border-r" : "w-full",
          )}
        >
          {pane.node}
        </div>
      )}
      <div ref={session} className="flex min-w-0 flex-1 flex-col">
        {/* The project's own route has nothing to add beside it. */}
        {pane && !open ? null : children}
      </div>
    </div>
  )
}

export function AppShell({ children }: { children?: ReactNode }) {
  // Lazy so a blocked or missing localStorage cannot keep the saved fold from applying on first render.
  const [collapsed, setCollapsed] = useState(() => loadSidebarCollapsed(() => window.localStorage))
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  const large = useLarge()
  const main = useRef<HTMLElement>(null)
  const project = useProjectPane()
  const bot = useBotPane(useBotThreads())
  const pane: ListPane | undefined = project
    ? {
        screen: `/code/${project.profileId}/${project.projectId}`,
        open: Boolean(project.session),
        node: (
          <ProjectPage
            key={`${project.profileId}/${project.projectId}`}
            pane={project}
            session={project.session}
          />
        ),
      }
    : bot && {
        screen: `/b/${bot.profileId}`,
        open: Boolean(bot.thread),
        node: <BotThreadsPage key={bot.profileId} profileId={bot.profileId} thread={bot.thread} />,
      }
  usePageTransition(main, pane)
  const width = sidebarWidth(collapsed, large)

  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty("--sidebar-width", width)
    return () => {
      root.style.removeProperty("--sidebar-width")
    }
  }, [width])

  return (
    <DrawerContext.Provider value={() => setOpen(true)}>
      <div
        className="flex h-dvh overflow-hidden bg-background"
        style={{ "--sidebar-width": width } as CSSProperties}
      >
        <aside
          className={cn(
            "hidden shrink-0 border-r bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none md:block",
            collapsed ? "w-[68px]" : "w-72 lg:w-80",
          )}
        >
          <ConversationList
            collapsed={collapsed}
            onToggleSidebar={() => {
              setCollapsed(!collapsed)
              saveSidebarCollapsed(!collapsed, () => window.localStorage)
            }}
          />
        </aside>
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
  )
}
