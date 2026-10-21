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
 * `centered` gives a coding session's arrangement instead: the same leading control, then the title
 * centred over its subtitle with no picture — a session is a place in a project, not a conversation
 * with a bot. Its block is centred in the room the controls leave, which is the row's own centre
 * where they match in width; the muted mark moves into the actions, so it cannot pull the title off
 * centre.
 * `className` can pin it in the page's flow instead.
 */
export function ChatHeader({
  title,
  subtitle,
  botId,
  muted,
  showBot = true,
  centered = false,
  leading,
  actions,
  className,
}: {
  title: string
  botId?: string
  muted?: boolean
  showBot?: boolean
  centered?: boolean
  subtitle?: string
  leading?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const openDrawer = useOpenDrawer()
  const mark = muted && (
    <BellOffIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />
  )

  return (
    <header
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-background from-75% to-transparent px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-6",
        className,
      )}
    >
      <div data-slot="header-row" className="mx-auto flex max-w-3xl items-center gap-3">
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
        {showBot && !centered && <Bot id={botId} animate className="pointer-events-auto size-11" />}
        <div
          data-slot="header-text"
          className={cn(
            "pointer-events-auto flex min-w-0 flex-1 items-center gap-1.5",
            centered && "justify-center",
          )}
        >
          <div className={cn("flex min-w-0 flex-col", centered && "items-center")}>
            {title && (
              <span
                data-slot="header-title"
                className={cn("min-w-0 truncate text-sm font-semibold", centered && "max-w-full")}
              >
                {title}
              </span>
            )}
            {subtitle && (
              <span
                data-slot="header-line"
                className={cn(
                  "min-w-0 truncate text-[11px] leading-tight text-muted-foreground",
                  centered && "max-w-full",
                )}
              >
                {subtitle}
              </span>
            )}
          </div>
          {!centered && mark}
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">
          {centered && mark}
          {actions}
        </div>
      </div>
    </header>
  )
}
