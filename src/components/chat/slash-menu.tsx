import { useEffect } from "react"
import { PlusIcon, SettingsIcon, SparklesIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { optionId, type SkillsState, type SlashItem } from "@/lib/slash"
import { cn } from "@/lib/utils"

const COMMAND_ICONS = { new: PlusIcon, settings: SettingsIcon }

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
    <div className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-3xl border bg-popover text-popover-foreground shadow-lg shadow-black/5">
      <ul
        id={id}
        role="listbox"
        aria-label="Commands and skills"
        className="max-h-72 overflow-y-auto p-1.5"
      >
        {items.map((item, index) => {
          const Icon = item.kind === "command" ? COMMAND_ICONS[item.name] : SparklesIcon
          return (
            <li
              key={`${item.kind}:${item.name}`}
              id={optionId(id, index)}
              role="option"
              aria-selected={index === active}
              // Keep focus (and the keyboard) on the textarea.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => index !== active && onActive(index)}
              onClick={() => onPick(item)}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-3 py-2",
                index === active && "bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm">/{item.name}</div>
                {item.description && (
                  <div className="truncate text-xs text-muted-foreground">{item.description}</div>
                )}
              </div>
              {item.kind === "skill" && item.category && (
                <Badge variant="secondary" className="max-w-28">
                  <span className="truncate">{item.category}</span>
                </Badge>
              )}
            </li>
          )
        })}
      </ul>
      {status !== "ok" && (
        <div className="flex items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
          {status === "loading" ? (
            <>
              <Spinner className="size-3.5" /> Loading skills…
            </>
          ) : (
            "Couldn't load skills from Hermes."
          )}
        </div>
      )}
    </div>
  )
}
