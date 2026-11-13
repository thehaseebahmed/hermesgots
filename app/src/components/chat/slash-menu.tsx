import { useEffect } from "react"
import {
  CornerDownRightIcon,
  KeyboardIcon,
  ListPlusIcon,
  SettingsIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react"

import { MenuBox } from "@/components/chat/menu-box"
import { PickGroup, PickRow } from "@/components/pick-row"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { optionId, type LocalCommand, type SendMode, type SlashItem } from "@/lib/slash"
import type { SkillsState } from "@/lib/skills"

const COMMAND_ICONS: Record<LocalCommand | SendMode, LucideIcon> = {
  settings: SettingsIcon,
  cheatsheet: KeyboardIcon,
  steer: CornerDownRightIcon,
  queue: ListPlusIcon,
}

export function SlashMenu({
  id,
  items,
  active,
  status,
  onPick,
  onActive,
}: {
  id: string
  items: SlashItem[]
  active: number
  status: SkillsState["status"]
  onPick: (item: SlashItem) => void
  onActive: (index: number) => void
}) {
  useEffect(() => {
    document.getElementById(optionId(id, active))?.scrollIntoView({ block: "nearest" })
  }, [id, active])

  return (
    <MenuBox>
      {(room) => (
        <>
          <PickGroup
            mode="option"
            label="Commands and skills"
            id={id}
            style={{ maxHeight: room }}
            className="overflow-y-auto p-1.5"
          >
            {items.map((item, index) => {
              const Icon = item.kind === "command" ? COMMAND_ICONS[item.name] : SparklesIcon
              return (
                <PickRow
                  key={`${item.kind}:${item.name}`}
                  id={optionId(id, index)}
                  leading={<Icon className="size-4 text-muted-foreground" />}
                  title={
                    <>
                      <span className="min-w-0 truncate font-mono text-sm">/{item.name}</span>
                      {item.kind === "skill" && item.category && (
                        <Badge variant="secondary" className="max-w-28">
                          <span className="truncate">{item.category}</span>
                        </Badge>
                      )}
                    </>
                  }
                  line={item.kind === "skill" ? item.description : undefined}
                  active={index === active}
                  onActive={() => index !== active && onActive(index)}
                  onPick={() => onPick(item)}
                />
              )
            })}
          </PickGroup>
          {/* A bot whose host can't list skills shows the commands alone; silently, as a missing feature. */}
          {status === "loading" && (
            <div className="flex items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Loading skills…
            </div>
          )}
        </>
      )}
    </MenuBox>
  )
}
