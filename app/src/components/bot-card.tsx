import { useEffect, useRef, type ComponentProps, type ReactNode } from "react"

import { Bot } from "@/components/bot"
import { cn } from "@/lib/utils"

/** A bot (Hermes profile) as a small tappable card: its image over its name. */
export function BotCard({
  botId,
  name,
  selected = false,
  icon,
  className,
  ...props
}: ComponentProps<"button"> & {
  botId?: string
  name: string
  selected?: boolean
  /** Shown instead of the bot, e.g. for an "add" card. */
  icon?: ReactNode
}) {
  const ref = useRef<HTMLButtonElement>(null)

  // Keep the selected bot visible in a scrolled strip.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [selected])

  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={icon ? undefined : selected}
      className={cn(
        "flex w-19 shrink-0 flex-col items-center gap-1 rounded-2xl bg-card px-1.5 pt-2 pb-1.5 text-card-foreground ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        selected && "bg-primary/10 ring-2 ring-primary hover:bg-primary/15",
        className,
      )}
      {...props}
    >
      <span aria-hidden className="flex size-10 items-center justify-center text-muted-foreground">
        {icon ?? <Bot id={botId} className="size-10" />}
      </span>
      <span className={cn("w-full truncate text-center text-xs", selected && "font-semibold")}>
        {name}
      </span>
    </button>
  )
}
