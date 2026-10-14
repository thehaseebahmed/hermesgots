import { useEffect, useRef, type ComponentProps, type ReactNode } from "react"
import { TriangleAlertIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { cn } from "@/lib/utils"

/** A connectivity dot: green while its host checks in, grey once it goes stale. */
export function OnlineDot({ online }: { online?: boolean }) {
  if (online === undefined) return null
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "block size-2.5 rounded-full",
          online ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
      <span className="sr-only">{online ? "Online" : "Offline"}</span>
    </>
  )
}

/** A bot (Hermes profile) as a small tappable card: its image over its name. */
export function BotCard({
  botId,
  name,
  selected = false,
  icon,
  warning,
  online,
  dimmed = false,
  className,
  ...props
}: ComponentProps<"button"> & {
  botId?: string
  name: string
  selected?: boolean
  /** Shown instead of the bot, e.g. for an "add" card. */
  icon?: ReactNode
  /** Flags the card, with this as its accessible description. */
  warning?: string
  /** A dot for whether its host is checking in; none when unknown. */
  online?: boolean
  /** Turned off. */
  dimmed?: boolean
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
        "relative flex w-19 shrink-0 flex-col items-center gap-1 rounded-2xl bg-card px-1.5 pt-2 pb-1.5 text-card-foreground ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        selected && "bg-primary/10 ring-2 ring-primary hover:bg-primary/15",
        dimmed && "text-muted-foreground",
        className,
      )}
      {...props}
    >
      {online !== undefined && !warning && (
        <span className="absolute top-1.5 right-1.5">
          <OnlineDot online={online} />
        </span>
      )}
      {warning && (
        <span className="absolute top-1 right-1 text-warning">
          <TriangleAlertIcon aria-hidden className="size-3.5" />
          <span className="sr-only">{warning}</span>
        </span>
      )}
      <span aria-hidden className="flex size-10 items-center justify-center text-muted-foreground">
        {icon ?? <Bot id={botId} className={cn("size-10", dimmed && "opacity-40")} />}
      </span>
      <span className={cn("w-full truncate text-center text-xs", selected && "font-semibold")}>
        {name}
      </span>
    </button>
  )
}
