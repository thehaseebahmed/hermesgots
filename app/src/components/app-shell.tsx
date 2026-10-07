import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { Outlet, useLocation, useNavigationType } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { DrawerContext } from "@/components/drawer-context"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useLarge } from "@/lib/media"
import { depth } from "@/lib/nav"

/** From `lg` Settings' sections open beside its menu, so they count as one screen. */
const screenOf = (path: string, large: boolean) =>
  large && path.startsWith("/settings") ? "/settings" : path

/**
 * Animates the main pane in when the screen changes: from the right when it was opened on top of
 * the last one, from the left when going back to it, and a fade when it took the last one's place.
 */
function usePageTransition(ref: RefObject<HTMLElement | null>) {
  const location = useLocation()
  const type = useNavigationType()
  const large = useLarge()
  const last = useRef({ screen: screenOf(location.pathname, large), idx: depth() })

  useLayoutEffect(() => {
    const previous = last.current
    last.current = { screen: screenOf(location.pathname, large), idx: depth() }
    if (last.current.screen === previous.screen) return
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
  }, [location, type, large, ref])
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const main = useRef<HTMLElement>(null)
  usePageTransition(main)

  return (
    <DrawerContext.Provider value={() => setOpen(true)}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <aside className="hidden w-72 shrink-0 border-r bg-sidebar text-sidebar-foreground md:block lg:w-80">
          <ConversationList />
        </aside>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-[85vw] max-w-80 p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            <ConversationList onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <main ref={main} className="flex min-w-0 flex-1 flex-col overflow-x-clip">
          {children ?? <Outlet />}
        </main>
      </div>
    </DrawerContext.Provider>
  )
}
