/**
 * What a session's close ended with, and whether this device has already said it — the pure half of
 * telling a close (ADR 0075). Import-free, so `scripts/test-close-report.mjs` runs it as a rule.
 *
 * A close is the host's work: Delete and Discard ask for one and the row moves at the tap, so the
 * report is read afterwards — by the device that pressed the button if it is still there, and by the
 * device that next opens Code if it is not. Each device keeps a mark of the reports it has told, the
 * same shape as a read mark, so a report is told once and never again.
 */

export interface KeptTree {
  name: string
  reason: "dirty" | "unpushed"
}

/** One repository the close touched, and what it managed there. */
export interface ClosedRepo {
  name: string
  /** The pull request it closed. */
  closed: number | null
  branchDeleted: boolean
  error: string | null
}

/** A session's close as the host keeps it. */
export interface CloseReport {
  sessionId: string
  /** `none` is a host that was never asked to close this session. */
  state: "none" | "closing" | "done"
  startedAt: number
  endedAt: number | null
  /** The session's repositories, by name, as they stood when the close was asked for. */
  repos: string[]
  removed: boolean
  kept: KeptTree[]
  results: ClosedRepo[]
  error: string | null
}

/** Something the user is told about a close: a toast, in the tone its news deserves. */
export interface CloseLine {
  tone: "info" | "error"
  text: string
}

/** The mark a report is told against, for this bot and session. */
export const closeToldKey = (profileId: string, sessionId: string) => `${profileId}\n${sessionId}`

/**
 * Whether this device still owes the user this report: it has ended, and the mark held for it is
 * older than the close. A report from before the mark — a close this device already told — says
 * nothing, and one still running has nothing to say yet.
 */
export function closeUntold(
  marks: Record<string, number>,
  profileId: string,
  close: Pick<CloseReport, "sessionId" | "state" | "startedAt">,
) {
  if (close.state !== "done" || !close.sessionId || !close.startedAt) return false
  return (marks[closeToldKey(profileId, close.sessionId)] ?? 0) < close.startedAt
}

/**
 * What the report says, in the app's own words: a tree it kept and why, each repository that
 * refused, and the removal's own failure. Nothing at all for a close that went as asked — the row
 * has already moved, and a toast for the ordinary case is noise.
 *
 * `named` is whether the session worked in more than one repository, which is when a per-repo
 * refusal has to say which one: with a single repository the refusal's own words are enough, as the
 * synchronous close always said them.
 */
export function closeLines(close: CloseReport, named = true): CloseLine[] {
  const lines: CloseLine[] = []
  for (const tree of close.kept) {
    const why = tree.reason === "dirty" ? "uncommitted" : "unpushed"
    lines.push({ tone: "info", text: `Kept ${tree.name}: it has ${why} changes.` })
  }
  for (const result of close.results) {
    if (!result.error) continue
    lines.push({ tone: "error", text: named ? `${result.name}: ${result.error}` : result.error })
  }
  if (close.error) lines.push({ tone: "error", text: close.error })
  return lines
}
