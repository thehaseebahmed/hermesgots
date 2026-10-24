import type { ReactNode } from "react"
import { BellOffIcon, MenuIcon } from "lucide-react"

import { useOpenDrawer } from "@/components/drawer-context"
import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"
import { COLUMN_BOX } from "@/lib/layout"
import { cn } from "@/lib/utils"

/**
 * Floating header, read from the left: the drawer button (or `leading`), the bot's picture (unless
 * `showBot` is false), then the title with its status under it, both cut with an ellipsis; actions
 * right.
 * `centered` gives the arrangement of a place rather than a conversation with a bot — a coding
 * session, or a bot's thread open beside its Main: the same leading control, then the title centred
 * over its subtitle. The muted mark moves into the actions, so it cannot pull the title off centre.
 * A session is a place in a project and a thread open beside Main is already somewhere, so both pass
 * `showBot={false}`: the picture stays a caller's decision, and the arrangement doesn't second-guess
 * it.
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
      <div
        data-slot="header-row"
        className={cn(
          COLUMN_BOX,
          centered
            ? "grid grid-cols-[1fr_minmax(0,2fr)_1fr] items-center gap-3"
            : "flex items-center gap-3",
        )}
      >
        {leading ? (
          <div className="pointer-events-auto shrink-0">{leading}</div>
        ) : (
          <>
            <Button
              variant="outline"
              size="icon-lg"
              className="pointer-events-auto size-11 shrink-0 rounded-full bg-background/80 backdrop-blur md:hidden"
              onClick={openDrawer}
              aria-label="Open conversations"
            >
              <MenuIcon />
            </Button>
            {/* The centred arrangement holds the row's centre by both flanks sharing it, so where
                nothing leads the row — a thread beside its bot — the leading track still takes a
                box. Below `md` the drawer above is that box. */}
            {centered && <div aria-hidden className="hidden size-11 md:block" />}
          </>
        )}
        {showBot && <Bot id={botId} animate className="pointer-events-auto size-11" />}
        <div
          data-slot="header-middle"
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
        <div
          data-slot="header-actions"
          className={cn(
            "pointer-events-auto flex shrink-0 items-center gap-2",
            centered && "justify-self-end",
          )}
        >
          {centered && mark}
          {actions}
        </div>
      </div>
    </header>
  )
}
