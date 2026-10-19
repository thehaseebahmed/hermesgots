import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A row of pills where one of a few values is active, each a radio of one group.
 *
 * One control for the app's short choices — the goal wizard's reviewers, a research format, a
 * server's transport — so a change to how it reads (its roles, its height, the shape of the raised
 * pill) is one edit rather than one per screen. The value is a radio rather than a pressed button:
 * the pills are alternatives, and only one is ever on.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: { id: T; label: string; icon?: LucideIcon }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
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
              "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors disabled:opacity-50",
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
