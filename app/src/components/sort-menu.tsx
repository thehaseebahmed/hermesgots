import { ArrowDownUpIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * The one sort control: an icon button naming the current order, a menu of every choice in
 * `options`, the chosen one marked. Code's sessions, the sidebar's bots and the Library tree all
 * drew their own copy of this; each keeps its own `by` and `label` wording, the control is one.
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
  options: Record<K, string>
  value: K
  onSort: (sort: K) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="h-11 shrink-0 gap-1.5 rounded-full px-3 text-xs text-muted-foreground"
            aria-label={`Sort ${by} by ${options[value]}`}
          />
        }
      >
        <ArrowDownUpIcon />
        {options[value]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={(next) => onSort(next as K)}>
            {(Object.keys(options) as K[]).map((option) => (
              <DropdownMenuRadioItem
                key={option}
                value={option}
                className="min-h-11"
                closeOnClick
              >
                {options[option]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
