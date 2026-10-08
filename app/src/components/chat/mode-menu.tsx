import {
  ChevronDownIcon,
  LockIcon,
  MapIcon,
  PencilLineIcon,
  SailboatIcon,
  ZapIcon,
} from "lucide-react"

import { useState } from "react"

import { TheseusIntro } from "@/components/chat/theseus-intro"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { SessionMode } from "@/lib/db"
import type { TheseusInfo } from "@/lib/hermes"
import { introSeen } from "@/lib/theseus"
import { MODE_LABELS } from "@/lib/workspace"

const MODES: { mode: SessionMode; icon: typeof ZapIcon }[] = [
  { mode: "accept_edits", icon: PencilLineIcon },
  { mode: "auto", icon: ZapIcon },
  { mode: "plan", icon: MapIcon },
]

/** The session's permission mode, as a pill that opens a menu of the three (four with Theseus). */
export function ModeMenu({
  mode,
  onChange,
  disabled,
  autoAvailable,
  theseus,
  started,
}: {
  mode: SessionMode
  onChange: (mode: SessionMode) => void
  disabled?: boolean
  /** Auto is answered by the plugin on the server, so it needs the plugin. */
  autoAvailable: boolean
  /** Theseus runs on the host's Node and needs the plugin to have it; undefined while that's asked. */
  theseus?: TheseusInfo | null
  /** The session has had a turn: Theseus can't be picked any more, and can't be left. */
  started?: boolean
}) {
  const [intro, setIntro] = useState(false)
  const Icon =
    mode === "theseus" ? SailboatIcon : (MODES.find((m) => m.mode === mode)?.icon ?? PencilLineIcon)
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
    (option === "auto" && !autoAvailable) ||
    (locked && option !== "theseus") ||
    (option === "theseus" &&
      mode !== "theseus" &&
      (!autoAvailable || Boolean(started) || unavailable !== null))
  const options = [...MODES, { mode: "theseus" as SessionMode, icon: SailboatIcon }]
  return (
    <>
      <TheseusIntro open={intro} onOpenChange={setIntro} onUse={() => onChange("theseus")} />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <Button
              type="button"
              variant="secondary"
              className="h-11 gap-1.5 rounded-full pr-2.5 pl-3"
              aria-label={`Mode: ${MODE_LABELS[mode]}`}
            />
          }
        >
          <Icon />
          {MODE_LABELS[mode]}
          {locked ? (
            <LockIcon className="size-3.5 text-muted-foreground" aria-label="Locked" />
          ) : (
            <ChevronDownIcon className="text-muted-foreground" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          <DropdownMenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              // The first time on this device, Theseus is explained before it's taken.
              if (value === "theseus" && mode !== "theseus" && !introSeen()) setIntro(true)
              else onChange(value as SessionMode)
            }}
          >
            {options.map(({ mode: option, icon: OptionIcon }) => (
              <div key={option} className="contents">
                {option === "theseus" && <DropdownMenuSeparator />}
                <DropdownMenuRadioItem
                  value={option}
                  className="min-h-11"
                  closeOnClick
                  disabled={off(option)}
                >
                  <OptionIcon />
                  <span className="flex flex-col">
                    {MODE_LABELS[option]}
                    {note(option) && (
                      <span className="text-xs text-muted-foreground">{note(option)}</span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              </div>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
