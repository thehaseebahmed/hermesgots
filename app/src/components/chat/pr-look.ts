import {
  CircleAlertIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Loader2Icon,
} from "lucide-react"

import type { PrState, PullRequestRef } from "@/lib/db"

interface PrLook {
  label: string
  icon: typeof GitPullRequestIcon
  /** The state's text colour on its own. */
  text: string
  className: string
  /** The icon spins: the checks are still running. */
  spin?: boolean
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

const PR_CHECKING: PrLook = {
  label: "checks running",
  icon: Loader2Icon,
  text: "text-warning",
  className: "bg-warning/15 text-warning hover:bg-warning/25",
  spin: true,
}

const PR_FAILING: PrLook = {
  label: "checks failing",
  icon: CircleAlertIcon,
  text: "text-warning",
  className: "bg-warning/15 text-warning hover:bg-warning/25",
}

/** The look a pull request wears: its state's, unless its checks are running or have failed. */
export function prLook(pr: PullRequestRef): PrLook {
  if (pr.state === "merged") return PR_LOOKS.merged
  if (pr.checks === "pending") return PR_CHECKING
  if (pr.checks === "failure") return PR_FAILING
  return PR_LOOKS[pr.state]
}

/**
 * The display label for a PR pill based on all PRs in the session.
 * Rules:
 * 1. Single PR, single repo → "PR #142"
 * 2. Multiple PRs from same repo → "repo #142"
 * 3. PRs from different repos, same owner → "repo #142"
 * 4. PRs from different owners → "owner/repo #142"
 */
export function prLabel(pr: PullRequestRef, allPrs: PullRequestRef[]) {
  if (allPrs.length === 1) return `PR #${pr.number}`
  const [owner] = pr.repo.split("/")
  const sameOwner = allPrs.every((p) => p.repo.startsWith(`${owner}/`))
  const uniqueRepos = new Set(allPrs.map((p) => p.repo))
  if (uniqueRepos.size === 1) return `${pr.repo.split("/")[1]} #${pr.number}`
  if (sameOwner) return `${pr.repo.split("/")[1]} #${pr.number}`
  return `${pr.repo} #${pr.number}`
}
