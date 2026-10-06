import { Browser } from "@capacitor/browser"
import {
  CircleAlertIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { PrState, PullRequestRef } from "@/lib/db"
import { isNative } from "@/lib/native"
import { cn } from "@/lib/utils"

interface Look {
  label: string
  icon: typeof GitPullRequestIcon
  className: string
}

const STATES: Record<PrState, Look> = {
  open: {
    label: "open",
    icon: GitPullRequestIcon,
    className: "bg-success/15 text-success hover:bg-success/25",
  },
  draft: {
    label: "draft",
    icon: GitPullRequestDraftIcon,
    className: "bg-muted text-muted-foreground hover:bg-muted/70",
  },
  merged: {
    label: "merged",
    icon: GitMergeIcon,
    className: "bg-merged/15 text-merged hover:bg-merged/25",
  },
  closed: {
    label: "closed",
    icon: GitPullRequestClosedIcon,
    className: "bg-destructive/15 text-destructive hover:bg-destructive/25",
  },
}

const FAILING: Look = {
  label: "checks failing",
  icon: CircleAlertIcon,
  className: "bg-warning/15 text-warning hover:bg-warning/25",
}

function open(url: string) {
  if (isNative) void Browser.open({ url })
  else window.open(url, "_blank", "noopener")
}

/**
 * A session's pull request as a pill above the composer, coloured by state (orange when its
 * checks fail); opens it on GitHub. `named` adds the repo, for a session that spans several.
 */
export function PrPill({
  pr,
  named,
  className,
}: {
  pr: PullRequestRef
  named?: boolean
  className?: string
}) {
  const state = STATES[pr.state]
  const look = pr.checks === "failure" && pr.state !== "merged" ? FAILING : state
  const Icon = look.icon
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn("h-11 gap-2 rounded-full px-4 tabular-nums", look.className, className)}
      disabled={!pr.url}
      onClick={() => pr.url && open(pr.url)}
      aria-label={`Pull request ${pr.number} in ${pr.repo}, ${state.label}${
        look === FAILING ? ", checks failing" : ""
      }`}
    >
      <Icon className="size-4" />
      {named && pr.repo ? `${pr.repo} #${pr.number}` : `PR #${pr.number}`}
    </Button>
  )
}
