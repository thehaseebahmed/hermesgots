import { CheckIcon, LockIcon, MapIcon, PencilLineIcon, SailboatIcon, ZapIcon } from "lucide-react"

import { ExperimentalBadge } from "@/components/experimental-badge"
import type { SessionMode } from "@/lib/db"
import type { TheseusInfo } from "@/lib/hermes"
import { useTheseusEnabled } from "@/lib/theseus"
import { cn } from "@/lib/utils"
import { MODE_LABELS } from "@/lib/workspace"

const MODES: { mode: SessionMode; icon: typeof ZapIcon }[] = [
  { mode: "accept_edits", icon: PencilLineIcon },
  { mode: "auto", icon: ZapIcon },
  { mode: "plan", icon: MapIcon },
]

/** A mode's icon, as the options list shows it. */
export function ModeIcon({ mode, className }: { mode: SessionMode; className?: string }) {
  const Icon =
    mode === "theseus" ? SailboatIcon : (MODES.find((m) => m.mode === mode)?.icon ?? PencilLineIcon)
  return <Icon className={className} aria-hidden />
}

export interface ModeSettings {
  mode: SessionMode
  onMode: (mode: SessionMode) => void
  /** Auto is answered by the plugin on the server, so it needs the plugin. */
  autoAvailable: boolean
  /** Theseus runs on the host's Node and needs the plugin to have it; undefined while that's asked. */
  theseus?: TheseusInfo | null
  /** The session has had a turn: Theseus can't be picked any more, and can't be left. */
  started?: boolean
}

/** The session's permission modes, as rows in the Add context sheet (four with Theseus). */
export function ModeOptions({
  mode,
  autoAvailable,
  theseus,
  started,
  disabled,
  onPick,
}: Omit<ModeSettings, "onMode"> & { disabled?: boolean; onPick: (mode: SessionMode) => void }) {
  const theseusEnabled = useTheseusEnabled()
  const locked = mode === "theseus" && started
  // Why Theseus can't be picked on this host, if it can't.
  const unavailable =
    theseus === undefined
      ? "Checking the host"
      : theseus === null
        ? "Needs a newer plugin"
        : theseus.ready
          ? null
          : (theseus.reason ?? "Not available on this host")
  const note = (option: SessionMode) => {
    if (option === "auto" && !autoAvailable) return "Needs the plugin"
    if (locked && option !== "theseus") return "Not in a Theseus session"
    if (option === "theseus") {
      if (!autoAvailable) return "Needs the plugin"
      if (started && mode !== "theseus") return "Only for a new session"
      return unavailable && mode !== "theseus" ? unavailable : "Gated checkpoints, in Auto"
    }
  }
  const off = (option: SessionMode) =>
    disabled ||
    (option === "auto" && !autoAvailable) ||
    (locked && option !== "theseus") ||
    (option === "theseus" &&
      mode !== "theseus" &&
      (!autoAvailable || Boolean(started) || unavailable !== null))
  // A session already in Theseus keeps showing it after the Developer switch goes off.
  const options =
    theseusEnabled || mode === "theseus"
      ? [...MODES, { mode: "theseus" as SessionMode, icon: SailboatIcon }]
      : MODES
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className="flex flex-col overflow-hidden rounded-2xl bg-muted/60 p-1"
    >
      {options.map(({ mode: option, icon: Icon }) => {
        const selected = option === mode
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={off(option)}
            onClick={() => onPick(option)}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] transition-colors hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent",
              selected && "bg-background",
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2">
                {MODE_LABELS[option]}
                {option === "theseus" && <ExperimentalBadge />}
              </span>
              {note(option) && (
                <span className="text-sm text-muted-foreground">{note(option)}</span>
              )}
            </span>
            {selected &&
              (locked ? (
                <LockIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Locked" />
              ) : (
                <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
              ))}
          </button>
        )
      })}
    </div>
  )
}
