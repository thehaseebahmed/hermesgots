import { ArrowDownNarrowWideIcon, ArrowDownUpIcon, ArrowUpNarrowWideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toggleSort, type Sort, type SortKey } from "@/lib/sort"

/**
 * The one sort control: an icon button naming what the list is sorted by, and a menu of every key
 * it can rank by. The row that is the list's order carries the arrow it reads in — up for A→Z and
 * oldest-first, down for newest-first — and picking that row again turns the arrow round, while
 * picking another row takes that key's own direction (ADR 0091). Code's sessions, the sidebar's
 * bots, the Library's tree and the model sheet all draw this; each keeps its own `by` and `label`
 * wording, the control and its rule are one.
 */
export function SortMenu<K extends string>({
  by,
  label = "Sort by",
  options,
  value,
  onSort,
}: {
  /** What is being sorted, named: the trigger reads "Sort <by> by <choice>". */
  by: string
  /** The menu's own heading, where a list words it its own way. */
  label?: string
  options: readonly SortKey<K>[]
  value: Sort<K>
  onSort: (sort: Sort<K>) => void
}) {
  const chosen = options.find((option) => option.key === value.key) ?? options[0]
  const Arrow = value.dir === "asc" ? ArrowUpNarrowWideIcon : ArrowDownNarrowWideIcon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="h-11 shrink-0 gap-1.5 rounded-full px-3 text-xs text-muted-foreground"
            aria-label={`Sort ${by} by ${chosen.label}, ${value.dir === "asc" ? "ascending" : "descending"}`}
          />
        }
      >
        <ArrowDownUpIcon />
        {chosen.label}
        <Arrow className="size-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {options.map((option) => {
            const picked = option.key === value.key
            const Mark = value.dir === "asc" ? ArrowUpNarrowWideIcon : ArrowDownNarrowWideIcon
            return (
              <DropdownMenuItem
                key={option.key}
                className="min-h-11 justify-between gap-3"
                onClick={() => onSort(toggleSort(value, option.key, options))}
                data-sort-key={option.key}
                data-sort-dir={picked ? value.dir : undefined}
              >
                {option.label}
                {/* The list's own order says its arrow; every other row holds the same space, so a
                    tap never moves the words sideways. */}
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {picked && <Mark className="size-4" aria-hidden />}
                </span>
                {picked && (
                  <span className="sr-only">
                    {value.dir === "asc" ? "ascending" : "descending"}, tap again to flip
                  </span>
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
