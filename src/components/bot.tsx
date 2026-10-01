import { useId } from "react"

import { BOTS, DEFAULT_BOT_ID } from "@/components/bots"
import { cn } from "@/lib/utils"

/** Renders a bot still by default; `animate` (used by the header) brings it to life. */
export function Bot({
  id = DEFAULT_BOT_ID,
  animate = false,
  className,
}: {
  id?: string
  animate?: boolean
  className?: string
}) {
  const uid = useId().replace(/:/g, "")
  const bot = BOTS.find((b) => b.id === id) ?? BOTS[0]

  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label={bot.name}
      className={cn("size-8 shrink-0 overflow-visible", animate && "bot-animate", className)}
    >
      {bot.draw({ fur: `fur-${uid}`, fill: `fill-${uid}` })}
    </svg>
  )
}
