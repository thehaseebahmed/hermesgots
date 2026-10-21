import type { ReactNode } from "react"
import { BellOffIcon, MenuIcon } from "lucide-react"

import { useOpenDrawer } from "@/components/drawer-context"
import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Floating header, read from the left: the drawer button (or `leading`), the bot's picture (unless
 * `showBot` is false), then the title with its status under it, both cut with an ellipsis; actions
 * right.
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
        {leading ? (
          <div className="pointer-events-auto shrink-0">{leading}</div>
        ) : (
          <Button
            variant="outline"
            size="icon-lg"
            className="pointer-events-auto size-11 shrink-0 rounded-full bg-background/80 backdrop-blur md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
        )}
        {showBot && <Bot id={botId} animate className="pointer-events-auto size-11" />}
        <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1.5">
          <div className="flex min-w-0 flex-col">
            {title && <span className="min-w-0 truncate text-sm font-semibold">{title}</span>}
            {subtitle && (
              <span className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground">
                {subtitle}
              </span>
            )}
          </div>
          {muted && (
            <BellOffIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />
          )}
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </header>
  )
}
