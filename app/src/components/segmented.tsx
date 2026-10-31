import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A row of pills where one of a few values is active, each a radio of one group.
 *
 * One control for the app's short choices — a research format, a server's transport — so a change
 * to how it reads (its roles, its height, the shape of the raised pill) is one edit rather than one
 * per screen. The value is a radio rather than a pressed button: the pills are alternatives, and
 * only one is ever on.
 *
 * A value may be null, which is a choice of its own rather than a missing one: the usage threshold's
 * Off is a segment beside the percents, and its caller holds what off means (ADR 0026).
 */
export function Segmented<T extends string | number | null>({
  label,
  options,
  value,
  onChange,
  disabled,
  compact,
}: {
  label: string
  options: { id: T; label: string; icon?: LucideIcon }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  /**
   * A row of many short values — the usage threshold's Off and six tens — narrows each pill's
   * padding so the whole row fits a phone's width without scrolling (ADR 0026).
   */
  compact?: boolean
}) {
  return (
    <div className="flex gap-1 rounded-full bg-muted p-1" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const Icon = option.icon
        const on = value === option.id
        return (
          <button
            key={String(option.id)}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            className={cn(
              // 44px: the pills are the only control in their row, and a thumb hits the target.
              "flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full text-sm font-medium text-muted-foreground transition-colors disabled:opacity-50",
              compact ? "px-1.5" : "px-3",
              on && "bg-background text-foreground shadow-sm",
            )}
          >
            {Icon && <Icon className="size-4" aria-hidden />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
