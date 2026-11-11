import { useLiveQuery } from "dexie-react-hooks"
import { ChevronDownIcon } from "lucide-react"
import { useMemo } from "react"

import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { listEnabledProfiles, setActiveProfile, type Profile } from "@/lib/db"

/**
 * Which bot a new chat goes to, as a pill above the composer. The bots are listed by name, a picker
 * being read for one someone is looking for rather than for the order they were linked in.
 *
 * `onPick` hands the choice to the caller instead of making it the account's active bot: the share
 * sheet sends into the bot it picked, and switches the active one only when the note goes.
 */
export function BotPicker({
  profile,
  onPick,
}: {
  profile: Profile
  onPick?: (bot: Profile) => void
}) {
  const answering = useLiveQuery(listEnabledProfiles, [])
  const profiles = useMemo(
    () => [...(answering ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [answering],
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            className="h-11 gap-2 rounded-full pr-2.5 pl-2"
            aria-label={`Bot: ${profile.name}`}
          />
        }
      >
        <Bot id={profile.botId} className="size-7" />
        <span className="max-w-48 truncate">{profile.name}</span>
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup
          value={profile.id}
          onValueChange={(value) => {
            const picked = profiles.find((option) => option.id === value)
            if (!picked) return
            if (onPick) onPick(picked)
            else void setActiveProfile(picked.id)
          }}
        >
          {profiles?.map((option) => (
            <DropdownMenuRadioItem
              key={option.id}
              value={option.id}
              className="min-h-11"
              closeOnClick
            >
              <Bot id={option.botId} className="size-6" />
              <span className="truncate">{option.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
