import type { ReactNode } from "react"
import { BellOffIcon, MenuIcon } from "lucide-react"

import { useOpenDrawer } from "@/components/drawer-context"
import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Floating header: round drawer button (or `leading`) left, bot (unless `showBot` is false) + title
 * centre, actions right.
 * `className` can pin it in the page's flow instead.
 */
export function ChatHeader({
  title,
  subtitle,
  botId,
  muted,
  showBot = true,
  leading,
  actions,
  className,
}: {
  title: string
  botId?: string
  /** Its notifications are muted. */
  muted?: boolean
  showBot?: boolean
  subtitle?: string
  leading?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const openDrawer = useOpenDrawer()

  return (
    <header
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-background from-75% to-transparent px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-6",
        className,
      )}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <div className="pointer-events-auto size-11 shrink-0">
          {leading ?? (
            <Button
              variant="outline"
              size="icon-lg"
              className="size-11 rounded-full bg-background/80 backdrop-blur md:hidden"
              onClick={openDrawer}
              aria-label="Open conversations"
            >
              <MenuIcon />
            </Button>
          )}
        </div>
        <div className="pointer-events-auto flex min-w-0 flex-1 flex-col items-center">
          {showBot && <Bot id={botId} animate className="size-11" />}
          <div className="flex max-w-1/2 min-w-0 flex-col items-center empty:hidden">
            {title && (
              <span className="flex max-w-full items-center gap-1.5">
                <span className="truncate text-sm font-semibold">{title}</span>
                {muted && (
                  <BellOffIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label="Muted"
                  />
                )}
              </span>
            )}
            {subtitle && (
              <span className="max-w-full truncate text-[11px] leading-tight text-muted-foreground">
                {subtitle}
              </span>
            )}
          </div>
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </header>
  )
}
