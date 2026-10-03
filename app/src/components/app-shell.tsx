import { useState, type ReactNode } from "react"
import { Outlet } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { DrawerContext } from "@/components/drawer-context"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"

export function AppShell({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false)

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
        <main className="flex min-w-0 flex-1 flex-col">{children ?? <Outlet />}</main>
      </div>
    </DrawerContext.Provider>
  )
}
