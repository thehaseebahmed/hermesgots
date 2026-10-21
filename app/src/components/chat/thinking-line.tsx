import { memo, useId, useState } from "react"
import { ChevronRightIcon } from "lucide-react"

import { thinkingLabel } from "@/lib/thinking"
import { cn } from "@/lib/utils"

export const ThinkingLine = memo(function ThinkingLine({
  reasoning,
  thinking,
  spanMs,
}: {
  reasoning: string
  /** The model is still thinking, so the line streams open. */
  thinking: boolean
  /** How long this device watched the turn think, when it watched it at all. */
  spanMs?: number
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  const id = useId()
  const open = override ?? thinking
  return (
    <div className="-my-2 flex flex-col">
      <button
        type="button"
        className="flex min-h-11 items-center gap-1 self-start rounded-lg px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOverride(!open)}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden
        />
        {thinkingLabel({ thinking, spanMs })}
      </button>
      <div
        id={id}
        // Folded text would still be read out, so it leaves the tree until the line opens.
        aria-hidden={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <p className="px-1 pt-1 text-sm whitespace-pre-wrap text-muted-foreground">{reasoning}</p>
        </div>
      </div>
    </div>
  )
})
