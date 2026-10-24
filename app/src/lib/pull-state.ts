import type { PrState, PullRequestRef } from "@/lib/db"

/**
 * The states a pull request is still live in: open, or a draft waiting for review. Lives apart
 * from the schema so a pure rule (`session-work.ts`) can ask it without pulling the database in;
 * `db.ts` re-exports both, where the rest of the app finds them.
 */

export const LIVE_PR_STATES: PrState[] = ["open", "draft"]

/** Whether a pull request is one of a session's live ones. */
export const prIsLive = (pr: Pick<PullRequestRef, "state">) => LIVE_PR_STATES.includes(pr.state)

/** Whether a pull request's checks are still running or have failed: what waits on the watcher. */
export const prChecksWait = (pr: Pick<PullRequestRef, "checks">) =>
  pr.checks === "pending" || pr.checks === "failure"
