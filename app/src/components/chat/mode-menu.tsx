import { ChevronDownIcon, MapIcon, PencilLineIcon, ZapIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { SessionMode } from "@/lib/db"
import { MODE_LABELS } from "@/lib/workspace"

const MODES: { mode: SessionMode; icon: typeof ZapIcon }[] = [
  { mode: "accept_edits", icon: PencilLineIcon },
  { mode: "auto", icon: ZapIcon },
  { mode: "plan", icon: MapIcon },
]

/** The session's permission mode, as a pill that opens a menu of the three. */
export function ModeMenu({
  mode,
  onChange,
  disabled,
}: {
  mode: SessionMode
  onChange: (mode: SessionMode) => void
  disabled?: boolean
}) {
  const Icon = MODES.find((m) => m.mode === mode)?.icon ?? PencilLineIcon
  return (
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
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => onChange(value as SessionMode)}
        >
          {MODES.map(({ mode: option, icon: OptionIcon }) => (
            <DropdownMenuRadioItem key={option} value={option} className="min-h-11" closeOnClick>
              <OptionIcon />
              {MODE_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
