import { PILL } from "@/components/chat/pill"
import { prLook } from "@/components/chat/pr-look"
import { Button } from "@/components/ui/button"
import type { PullRequestRef } from "@/lib/db"
import { openExternal } from "@/lib/native"
import { cn } from "@/lib/utils"

/**
 * A session's pull request as a pill above the composer, coloured by state (orange while its
 * checks run, orange with an alert when they fail); opens it on GitHub. `label` is the precomputed
 * display text (e.g. "PR #142", "gots #142", or "thehaseebahmed/hermesgots #142").
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
      className={cn(PILL, "tabular-nums", look.className, className)}
      disabled={!pr.url}
      onClick={() => pr.url && openExternal(pr.url)}
      aria-label={`Pull request ${pr.number} in ${pr.repo}, ${look.label}`}
    >
      <Icon className={cn("size-4", look.spin && "motion-safe:animate-spin")} />
      {label}
    </Button>
  )
}
