import type { PullRequestRef } from "@/lib/db"

/**
 * A pull request of a session's, the way the plugin reports it — shared by the rule tests and the
 * row tests, so both draw the same one (`state`, then `checks`, then its moment).
 */
export const pr = (
  state: PullRequestRef["state"] = "open",
  checks: PullRequestRef["checks"] = null,
  at = 5,
): PullRequestRef => ({
  repo: "acme/gots",
  number: 7,
  title: "A change",
  state,
  checks,
  url: "https://example.test/7",
  at,
})
