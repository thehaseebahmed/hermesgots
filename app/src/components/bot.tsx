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
  const bot = BOTS.find((b) => b.id === id) ?? BOTS[0]

  return (
    <span
      role="img"
      aria-label={bot.name}
      className={cn("inline-block size-8 shrink-0", animate && "bot-animate", className)}
    >
      <img
        src={`/bots/${bot.id}.png`}
        alt=""
        draggable={false}
        className="bot-float size-full object-contain select-none"
      />
    </span>
  )
}
