import { prLook } from "@/components/chat/pr-look"
import { Button } from "@/components/ui/button"
import type { PullRequestRef } from "@/lib/db"
import { openExternal } from "@/lib/native"
import { cn } from "@/lib/utils"

/**
 * A session's pull request as a pill above the composer, coloured by state (orange while its
 * checks run, orange with an alert when they fail); opens it on GitHub. `label` is the precomputed
 * display text (e.g. "PR #142", "memento #142", or "thehaseebahmed/memento #142").
 */
export function PrPill({
  pr,
  label,
  className,
}: {
  pr: PullRequestRef
  label: string
  className?: string
}) {
  const look = prLook(pr)
  const Icon = look.icon
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn("h-11 gap-2 rounded-full px-4 tabular-nums", look.className, className)}
      disabled={!pr.url}
      onClick={() => pr.url && openExternal(pr.url)}
      aria-label={`Pull request ${pr.number} in ${pr.repo}, ${look.label}`}
    >
      <Icon className={cn("size-4", look.spin && "motion-safe:animate-spin")} />
      {label}
    </Button>
  )
}

/** A pull request as a row of a list: its state's icon, title, state, number and repo. */
export function PrRow({ pr }: { pr: PullRequestRef }) {
  const look = prLook(pr)
  const Icon = look.icon
  return (
    <button
      type="button"
      disabled={!pr.url}
      onClick={() => pr.url && openExternal(pr.url)}
      className="-mx-2 flex min-h-14 w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
    >
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-xl",
          look.className,
        )}
      >
        <Icon className={cn("size-5", look.spin && "motion-safe:animate-spin")} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{pr.title || `#${pr.number}`}</span>
        <span className="block truncate text-sm text-muted-foreground">
          <span className={look.text}>{look.label[0].toUpperCase() + look.label.slice(1)}</span>
          {` · #${pr.number} · ${pr.repo}`}
        </span>
      </span>
    </button>
  )
}
