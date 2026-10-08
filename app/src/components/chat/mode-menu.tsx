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
import { introSeen, THESEUS_PREVIEW } from "@/lib/theseus"
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
  started,
}: {
  mode: SessionMode
  onChange: (mode: SessionMode) => void
  disabled?: boolean
  /** Auto is answered by the plugin on the server, so it needs the plugin. */
  autoAvailable: boolean
  /** The session has had a turn: Theseus can't be picked any more, and can't be left. */
  started?: boolean
}) {
  const [intro, setIntro] = useState(false)
  const Icon =
    mode === "theseus" ? SailboatIcon : (MODES.find((m) => m.mode === mode)?.icon ?? PencilLineIcon)
  const locked = mode === "theseus" && started
  const note = (option: SessionMode) => {
    if ((option === "auto" || option === "theseus") && !autoAvailable) return "Needs the plugin"
    if (locked && option !== "theseus") return "Not in a Theseus session"
    if (option === "theseus")
      return started ? "Only for a new session" : "Gated checkpoints, in Auto"
  }
  const off = (option: SessionMode) =>
    ((option === "auto" || option === "theseus") && !autoAvailable) ||
    (locked && option !== "theseus") ||
    (option === "theseus" && Boolean(started) && mode !== "theseus")
  const options = [
    ...MODES,
    ...(THESEUS_PREVIEW || mode === "theseus"
      ? [{ mode: "theseus" as SessionMode, icon: SailboatIcon }]
      : []),
  ]
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
