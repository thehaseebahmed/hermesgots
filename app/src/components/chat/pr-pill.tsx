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

interface PrLook {
  label: string
  icon: typeof GitPullRequestIcon
  /** The state's text colour on its own. */
  text: string
  className: string
}

const PR_LOOKS: Record<PrState, PrLook> = {
  open: {
    label: "open",
    icon: GitPullRequestIcon,
    text: "text-success",
    className: "bg-success/15 text-success hover:bg-success/25",
  },
  draft: {
    label: "draft",
    icon: GitPullRequestDraftIcon,
    text: "text-muted-foreground",
    className: "bg-muted text-muted-foreground hover:bg-muted/70",
  },
  merged: {
    label: "merged",
    icon: GitMergeIcon,
    text: "text-merged",
    className: "bg-merged/15 text-merged hover:bg-merged/25",
  },
  closed: {
    label: "closed",
    icon: GitPullRequestClosedIcon,
    text: "text-destructive",
    className: "bg-destructive/15 text-destructive hover:bg-destructive/25",
  },
}

const PR_FAILING: PrLook = {
  label: "checks failing",
  icon: CircleAlertIcon,
  text: "text-warning",
  className: "bg-warning/15 text-warning hover:bg-warning/25",
}

function openPr(url: string) {
  if (isNative) void Browser.open({ url })
  else window.open(url, "_blank", "noopener")
}

/**
 * A session's pull request as a pill above the composer, coloured by state (orange when its
 * checks fail); opens it on GitHub. `label` is the precomputed display text (e.g. "PR #142",
 * "memento #142", or "thehaseebahmed/memento #142").
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
  const state = PR_LOOKS[pr.state]
  const look = pr.checks === "failure" && pr.state !== "merged" ? PR_FAILING : state
  const Icon = look.icon
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn("h-11 gap-2 rounded-full px-4 tabular-nums", look.className, className)}
      disabled={!pr.url}
      onClick={() => pr.url && openPr(pr.url)}
      aria-label={`Pull request ${pr.number} in ${pr.repo}, ${state.label}${
        look === PR_FAILING ? ", checks failing" : ""
      }`}
    >
      <Icon className="size-4" />
      {label}
    </Button>
  )
}

/** A pull request as a row of a list: its state's icon, title, state, number and repo. */
export function PrRow({ pr }: { pr: PullRequestRef }) {
  const state = PR_LOOKS[pr.state]
  const look = pr.checks === "failure" && pr.state !== "merged" ? PR_FAILING : state
  const Icon = look.icon
  return (
    <button
      type="button"
      disabled={!pr.url}
      onClick={() => pr.url && openPr(pr.url)}
      className="-mx-2 flex min-h-14 w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
    >
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-xl",
          look.className,
        )}
      >
        <Icon className="size-5" />
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
