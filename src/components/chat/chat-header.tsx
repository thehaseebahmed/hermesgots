import type { ReactNode } from "react"
import { MenuIcon } from "lucide-react"

import { useOpenDrawer } from "@/components/drawer-context"
import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"

/** Floating header: round drawer button left, bot + title centre, actions right. */
export function ChatHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle: string
  actions?: ReactNode
}) {
  const openDrawer = useOpenDrawer()

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-background via-background/90 to-transparent px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-6">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <div className="pointer-events-auto size-11 shrink-0">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full bg-background/80 backdrop-blur md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
        </div>
        <div className="pointer-events-auto flex min-w-0 flex-1 flex-col items-center">
          <Bot animate className="size-11" />
          <div className="-mt-1 flex max-w-full flex-col items-center rounded-full bg-background/80 px-3 py-0.5 backdrop-blur">
            <span className="max-w-full truncate text-sm font-semibold">{title}</span>
            <span className="text-[11px] leading-tight text-muted-foreground">{subtitle}</span>
          </div>
        </div>
        <div className="pointer-events-auto size-11 shrink-0">{actions}</div>
      </div>
    </header>
  )
}
