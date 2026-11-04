import { ArrowDownNarrowWideIcon, ArrowUpNarrowWideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { dirWord, toggleSort, type Sort, type SortKey } from "@/lib/sort"

/**
 * The one sort control: a button reading the list's order as one sign and one name, and a menu of
 * every key it can rank by. The sign is the direction arrow alone — up for A→Z and oldest-first,
 * down for newest-first — and it stands at the button's start, ahead of the name, so the control is a
 * sign and a word rather than three icons in a row. The row that is the list's order carries the same
 * arrow, and picking that row again turns it round while picking another row takes that key's own
 * direction (ADR 0091, amended by 0095).
 */
export function SortMenu<K extends string>({
  by,
  label = "Sort by",
  options,
  value,
  onSort,
  compact = false,
}: {
  /** What is being sorted, named: the trigger reads "Sort <by> by <choice>". */
  by: string
  /** The menu's own heading, where a list words it its own way. */
  label?: string
  options: readonly SortKey<K>[]
  value: Sort<K>
  onSort: (sort: Sort<K>) => void
  /**
   * A strip that holds another control beside it — a sheet's header, a list's title bar — wears the
   * sign alone, its key named in the menu and to a screen reader.
   */
  compact?: boolean
}) {
  const chosen = options.find((option) => option.key === value.key) ?? options[0]
  const Arrow = value.dir === "asc" ? ArrowUpNarrowWideIcon : ArrowDownNarrowWideIcon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={
              compact
                ? "size-11 shrink-0 rounded-full text-muted-foreground"
                : "h-11 shrink-0 gap-1.5 rounded-full px-3 text-xs text-muted-foreground"
            }
            aria-label={`Sort ${by} by ${chosen.label}, ${dirWord(value.dir)}`}
          />
        }
      >
        <Arrow className="size-4" aria-hidden />
        {!compact && chosen.label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {options.map((option) => {
            const picked = option.key === value.key
            return (
              <DropdownMenuItem
                key={option.key}
                className="min-h-11 justify-between gap-3"
                onClick={() => onSort(toggleSort(value, option.key, options))}
                data-sort-key={option.key}
                data-sort-dir={picked ? value.dir : undefined}
              >
                {option.label}
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {picked && <Arrow className="size-4" aria-hidden />}
                </span>
                {picked && (
                  <span className="sr-only">{dirWord(value.dir)}, tap again to flip</span>
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
