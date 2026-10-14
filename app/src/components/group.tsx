import type { ReactNode } from "react"
import { ChevronUpIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

/** A finished group longer than this starts folded. */
const FOLD_OVER = 5

/**
 * A titled list that folds away; a finished one (`fold`) longer than `FOLD_OVER` starts folded, and
 * an `"always"` one always does. It's mounted once its first item is known, so that count decides.
 */
export function Group({
  label,
  count,
  fold,
  children,
}: {
  label: string
  count: number
  fold?: boolean | "always"
  children: ReactNode
}) {
  return (
    <Collapsible
      defaultOpen={!fold || (fold !== "always" && count <= FOLD_OVER)}
      render={<section aria-label={label} />}
    >
      <h2>
        <CollapsibleTrigger className="group -mx-1 flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {label} ({count})
          <ChevronUpIcon className="size-4 rotate-180 transition-transform group-data-panel-open:rotate-0 motion-reduce:transition-none" />
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent>
        <ul>{children}</ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
