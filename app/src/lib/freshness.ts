/**
 * How fresh the app keeps what it shows, in one place. A screen reads again on its own timer only
 * while it's on screen and online (`usePoll`); where the server streams its changes (`live.ts`), the
 * timer drops to `SAFETY_MS` and the stream says when to read.
 */

/** The slow timer a screen keeps when its server streams its changes: a net, not the signal. */
export const SAFETY_MS = 5 * 60_000
/** A read that hasn't answered by now is treated as lost, since a dead connection can hang. */
export const READ_TIMEOUT_MS = 15_000
/** A plugin that lacks a route (an older one) is left alone this long before it's asked again. */
export const MISSING_ROUTE_MS = 5 * 60_000

/** Which runs are in flight and what waits on the user (`runs/live`), shared by every screen. */
export const RUNS_MS = 10_000
/** An open chat looks for turns sent from another device. */
export const CATCH_UP_MS = 30_000
/**
 * A chat's title, context use, todos, workspace and pull requests are read again when its
 * transcript moves, when its server says the session changed, and otherwise this often.
 */
export const FOLLOW_UP_MS = 2 * 60_000
/** A turn that ended within this long read them itself. */
export const JUST_FOLLOWED_UP_MS = 3_000
/** A send doesn't wait to catch the chat up when it caught up this recently. */
export const SEND_CAUGHT_UP_MS = 5_000
/** An open chat looks for a turn the plugin started from its queue, while one waits there. */
export const HOST_QUEUE_MS = 3_000
/** While the host does slow work the screen waits on (cloning a repo, adding or removing one). */
export const HOST_WORK_MS = 3_000
/** A Theseus run, and the agents a chat delegated to, while they work. */
export const AGENT_WORK_MS = 4_000

/** How long a known pull request is trusted before it's read again. */
export const PR_MS = 30_000
/** A pull request whose checks are still running, so the pill shows them as they finish. */
export const PR_PENDING_MS = 10_000
/** The project screen reads a session's worktree and pull requests again, at most this often. */
export const SESSION_REREAD_MS = 60_000

/** The Code and Routines lists. */
export const LIST_MS = 60_000
/** Whether the host can run Theseus. */
export const THESEUS_INFO_MS = 60_000
/** Whether the host can dictate. */
export const DICTATION_INFO_MS = 5 * 60_000
