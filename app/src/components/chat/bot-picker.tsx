import { useLiveQuery } from "dexie-react-hooks"
import { ChevronDownIcon, PlusIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { listProfiles, setActiveProfile, type Profile } from "@/lib/db"
import { useNav } from "@/lib/nav"

/** Which bot a new chat goes to, as a pill above the composer. */
export function BotPicker({ profile }: { profile: Profile }) {
  const { root } = useNav()
  const profiles = useLiveQuery(listProfiles, [])

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
          onValueChange={(value) => void setActiveProfile(value as string)}
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
        <DropdownMenuSeparator />
        <DropdownMenuItem className="min-h-11" onClick={() => root("/settings#bots")}>
          <PlusIcon />
          Add bot
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
