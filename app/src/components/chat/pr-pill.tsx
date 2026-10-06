import { Browser } from "@capacitor/browser"
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { PrState, PullRequestRef } from "@/lib/db"
import { isNative } from "@/lib/native"
import { cn } from "@/lib/utils"

const STATES: Record<
  PrState,
  { label: string; icon: typeof GitPullRequestIcon; className: string }
> = {
  open: { label: "Open", icon: GitPullRequestIcon, className: "text-success" },
  draft: { label: "Draft", icon: GitPullRequestDraftIcon, className: "text-muted-foreground" },
  merged: { label: "Merged", icon: GitMergeIcon, className: "text-primary" },
  closed: { label: "Closed", icon: GitPullRequestClosedIcon, className: "text-destructive" },
}

function open(url: string) {
  if (isNative) void Browser.open({ url })
  else window.open(url, "_blank", "noopener")
}

/** The session's pull request, as a pill above the composer; opens it on GitHub. */
export function PrPill({ pr }: { pr: PullRequestRef }) {
  const { label, icon: Icon, className } = STATES[pr.state]
  return (
    <Button
      type="button"
      variant="secondary"
      className="h-11 gap-2 rounded-full px-4 tabular-nums"
      disabled={!pr.url}
      onClick={() => pr.url && open(pr.url)}
      aria-label={`Pull request ${pr.number}, ${label.toLowerCase()}`}
    >
      <Icon className={cn("size-4", className)} />
      PR #{pr.number} · {label}
    </Button>
  )
}
