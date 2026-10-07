/** Why a project session is paused on the user. */
export type WaitingReason =
  { kind: "question"; count: number } | { kind: "approval"; command?: string } | { kind: "plan" }

/** A project session, in any project, that waits for the user. */
export interface WaitingSession {
  sessionId: string
  title: string
  reason: WaitingReason
  project?: string
  /** When it started waiting, newest first. */
  since: number
}

export function reasonText(reason: WaitingReason) {
  if (reason.kind === "question")
    return reason.count > 1 ? `${reason.count} questions to answer` : "Awaiting your answer"
  if (reason.kind === "approval")
    return reason.command ? `Approve ${reason.command}` : "Needs approval to run a command"
  return "Plan ready for review"
}

// MOCK: design-only fixtures until the plugin reports waiting sessions. Open the app with
// `?mock-waiting=few` or `?mock-waiting=many` to show them, and `?mock-waiting=off` to hide them.
const MOCK_KEY = "memento:mock-waiting"
const now = Date.now()
const min = 60_000

const FEW: WaitingSession[] = [
  {
    sessionId: "mock-waiting-1",
    title: "Add a waiting section to the sidebar",
    reason: { kind: "question", count: 1 },
    project: "Memento",
    since: now - 2 * min,
  },
  {
    sessionId: "mock-waiting-2",
    title: "Fix the flaky clone retry test",
    reason: { kind: "approval", command: "git push --force-with-lease" },
    project: "Hermes",
    since: now - 14 * min,
  },
  {
    sessionId: "mock-waiting-3",
    title: "Migrate settings to the new sheet",
    reason: { kind: "plan" },
    project: "Memento",
    since: now - 45 * min,
  },
]

const MORE: WaitingSession[] = [
  {
    sessionId: "mock-waiting-4",
    title: "Upgrade Capacitor to the latest release and fix the Android build",
    reason: { kind: "question", count: 3 },
    project: "Memento",
    since: now - 70 * min,
  },
  {
    sessionId: "mock-waiting-5",
    title: "Clean up stale worktrees",
    reason: { kind: "approval" },
    project: "Homelab scripts",
    since: now - 3 * 60 * min,
  },
  {
    sessionId: "mock-waiting-6",
    title: "Write the release notes",
    reason: { kind: "question", count: 1 },
    project: "Hermes",
    since: now - 5 * 60 * min,
  },
  {
    sessionId: "mock-waiting-7",
    title: "Rework the cron run ledger",
    reason: { kind: "plan" },
    project: "Hermes",
    since: now - 26 * 60 * min,
  },
]

function mockMode() {
  try {
    const param = new URLSearchParams(window.location.search).get("mock-waiting")
    if (param === "off") localStorage.removeItem(MOCK_KEY)
    else if (param) localStorage.setItem(MOCK_KEY, param)
    return localStorage.getItem(MOCK_KEY)
  } catch {
    return null
  }
}

const mock = mockMode()
const fixtures = mock === "many" ? [...FEW, ...MORE] : mock === "few" ? FEW : []

/** Project sessions waiting for the user, newest first. Mock data only for now. */
export function useWaitingSessions(): WaitingSession[] {
  return fixtures
}
