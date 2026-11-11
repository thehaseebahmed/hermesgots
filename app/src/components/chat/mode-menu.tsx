import { MapIcon, PencilLineIcon, ZapIcon } from "lucide-react"

import { PickGroup, PickRow } from "@/components/pick-row"
import type { SessionMode } from "@/lib/db"
import { MODE_LABELS } from "@/lib/workspace"

const MODES: { mode: SessionMode; icon: typeof ZapIcon }[] = [
  { mode: "accept_edits", icon: PencilLineIcon },
  { mode: "auto", icon: ZapIcon },
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
  /** Auto is answered by the plugin on the server, so it needs the plugin. */
  autoAvailable: boolean
}

/** The session's permission modes, as rows in the Add context sheet. */
export function ModeOptions({
  mode,
  autoAvailable,
  disabled,
  onPick,
}: Omit<ModeSettings, "onMode"> & { disabled?: boolean; onPick: (mode: SessionMode) => void }) {
  const note = (option: SessionMode) => {
    if (option === "auto" && !autoAvailable) return "Needs the plugin"
    if (option === "auto") return "Edits left to it"
  }
  const off = (option: SessionMode) => Boolean(disabled) || (option === "auto" && !autoAvailable)
  return (
    <PickGroup mode="choose" surface="plate" label="Mode">
      {MODES.map(({ mode: option, icon: Icon }) => (
        <PickRow
          key={option}
          leading={<Icon className="size-4 text-muted-foreground" aria-hidden />}
          title={MODE_LABELS[option]}
          line={note(option)}
          selected={option === mode}
          disabled={off(option)}
          onPick={() => onPick(option)}
        />
      ))}
    </PickGroup>
  )
}
