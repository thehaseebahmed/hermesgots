import { CheckIcon, SparklesIcon, type LucideIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * One skill's row: what it is called, what it is for, and the category it sits in — the same row in
 * the composer's menu (where it is a command to run now, so it reads `/name`) and in the sheets
 * where it is a choice to keep (where it reads its name and a check). One component, so a skill
 * looks the same wherever it is offered.
 *
 * The caller owns the list and what a pick means: this draws a row and reports the pointer.
 */
export function SkillRow({
  id,
  name,
  slash = false,
  category,
  description,
  selected = false,
  checked = false,
  active = false,
  icon: Icon = SparklesIcon,
  onPick,
  onActive,
}: {
  id?: string
  name: string
  /** Read it as the command it is in the composer (`/name`) rather than as the skill's name. */
  slash?: boolean
  category?: string | null
  description?: string | null
  /** Whether this row is the list's current one, for a reader that follows the keyboard. */
  selected?: boolean
  /** Whether this skill is one of those chosen, where the list is a choice of many. */
  checked?: boolean
  /** Whether the pointer is on this row. */
  active?: boolean
  icon?: LucideIcon
  onPick?: () => void
  onActive?: () => void
}) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      // Keep focus (and the keyboard) where the list was summoned from.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => onActive?.()}
      onClick={onPick}
      className={cn(
        "grid min-h-11 cursor-pointer grid-cols-[auto_1fr_auto] content-center items-center gap-x-3 rounded-2xl px-3 py-2",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {/* The icon rides the title's line, so a description hangs under the title, not the icon. */}
      <span className="row-start-1 flex h-5 items-center">
        <Icon className="size-4 text-muted-foreground" />
      </span>
      <div className="row-start-1 min-w-0 truncate font-mono text-sm">
        {slash ? `/${name}` : name}
      </div>
      <span className="row-start-1 flex items-center gap-2">
        {checked && <CheckIcon aria-hidden className="size-4" />}
        {category && (
          <Badge variant="secondary" className="max-w-28">
            <span className="truncate">{category}</span>
          </Badge>
        )}
      </span>
      {description && (
        <div className="col-start-2 min-w-0 truncate text-xs text-muted-foreground">
          {description}
        </div>
      )}
    </li>
  )
}
