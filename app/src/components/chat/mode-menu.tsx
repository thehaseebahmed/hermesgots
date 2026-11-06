import { CheckIcon, MapIcon, PencilLineIcon } from "lucide-react"

import type { SessionMode } from "@/lib/db"
import { cn } from "@/lib/utils"
import { MODE_LABELS } from "@/lib/workspace"

const MODES: { mode: SessionMode; icon: typeof MapIcon }[] = [
  { mode: "accept_edits", icon: PencilLineIcon },
  { mode: "plan", icon: MapIcon },
]

/** A mode's icon, as the options list shows it. */
export function ModeIcon({ mode, className }: { mode: SessionMode; className?: string }) {
  const Icon = MODES.find((m) => m.mode === mode)?.icon ?? PencilLineIcon
  return <Icon className={className} aria-hidden />
}

export interface ModeSettings {
  mode: SessionMode
  onMode: (mode: SessionMode) => void
}

/** The session's permission modes, as rows in the Add context sheet. */
export function ModeOptions({
  mode,
  disabled,
  onPick,
}: Omit<ModeSettings, "onMode"> & { disabled?: boolean; onPick: (mode: SessionMode) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className="flex flex-col overflow-hidden rounded-2xl bg-muted/60 p-1"
    >
      {MODES.map(({ mode: option, icon: Icon }) => {
        const selected = option === mode
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={Boolean(disabled)}
            onClick={() => onPick(option)}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] transition-colors hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent",
              selected && "bg-background",
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2">{MODE_LABELS[option]}</span>
            </span>
            {selected && <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}
