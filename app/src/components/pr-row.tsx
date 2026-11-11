import { prLook } from "@/components/chat/pr-look"
import { PickRow } from "@/components/pick-row"
import type { PullRequestRef } from "@/lib/db"
import { openExternal } from "@/lib/native"
import { cn } from "@/lib/utils"

/**
 * A pull request as a pick row: the state's disc as its mark, the title, then the state word, the
 * number and the repo on the muted line. It goes somewhere rather than choosing, so it draws the
 * chevron and no tick.
 */
export function PrRow({ pr }: { pr: PullRequestRef }) {
  const look = prLook(pr)
  const Icon = look.icon
  return (
    <PickRow
      leading={
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-xl",
            look.className,
          )}
        >
          <Icon className={cn("size-4", look.spin && "motion-safe:animate-spin")} />
        </span>
      }
      title={<span className="truncate font-medium">{pr.title || `#${pr.number}`}</span>}
      line={
        <>
          <span className={look.text}>{look.label[0].toUpperCase() + look.label.slice(1)}</span>
          {` · #${pr.number} · ${pr.repo}`}
        </>
      }
      label={`Pull request ${pr.number} in ${pr.repo}, ${look.label}`}
      disabled={!pr.url}
      onPick={() => pr.url && openExternal(pr.url)}
    />
  )
}
