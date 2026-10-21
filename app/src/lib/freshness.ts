/**
 * How fresh the app keeps what it shows, in one place. A screen reads again on its own timer only
 * while it's on screen and online (`usePoll`); where the server streams its changes (`live.ts`), the
 * timer drops to `SAFETY_MS` and the stream says when to read.
 */

/** The slow timer a screen keeps when its server streams its changes: a net, not the signal. */
export const SAFETY_MS = 5 * 60_000
/** A read that hasn't answered by now is treated as lost, since a dead connection can hang. */
export const READ_TIMEOUT_MS = 15_000
/** A write the host hasn't answered by now is given up on as well: a screen waiting on it (the bot
 * editor's fallback rows grey out with a save) has to come back, answer or not. */
export const WRITE_TIMEOUT_MS = 15_000

/**
 * A Server access start: the Host discovers the provider, registers a client and waits for the
 * authorization URL, which Hermes gives up to 30 s to produce before it answers.
 */
export const MCP_ACCESS_MS = 40_000
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
/** A message sent from Main waits this long for the host's triage before it stays in Main. */
export const TRIAGE_MS = 5_000
/** A send doesn't wait to catch the chat up when it caught up this recently. */
export const SEND_CAUGHT_UP_MS = 5_000
/** An open chat looks for a turn the plugin started from its queue, while one waits there. */
export const HOST_QUEUE_MS = 3_000
/** While the host does slow work the screen waits on (cloning a repo, adding or removing one). */
export const HOST_WORK_MS = 3_000
/** An agent a chat delegated to, while it works. */
export const AGENT_WORK_MS = 4_000

/** How long a known pull request is trusted before it's read again. */
export const PR_MS = 30_000
/** A pull request whose checks are still running, so the pill shows them as they finish. */
export const PR_PENDING_MS = 10_000
/** The project screen reads a session's worktree and pull requests again, at most this often. */
export const SESSION_REREAD_MS = 60_000

/** How long a known library count is trusted before it's read again. */
export const LIBRARY_MS = 60_000

/** A bot's MCP servers, while a server is connecting or the Server access sheet is open: a state that
 * moves on its own is watched; one the screen can't change is read once on open and left. */
export const MCP_WORK_MS = 3_000

/** Adding a server from the Catalogue, which the host may answer by cloning and installing the
 * entry's own repository: longer than a switch's write, so a slow one isn't given up on early. */
export const MCP_INSTALL_MS = 2 * 60_000

/** Saving a server's own block, or adding one by hand: a config write and the host's reconcile,
 * which takes a per-home lock and can back off, so it is given what an add is. */
export const MCP_SAVE_MS = 2 * 60_000

/** Listing one server's tools by having the host connect it once: as long as that server may take
 * to answer, since the probe waits on its own connect timeout rather than a read's. */
export const MCP_TOOLS_MS = 90_000

/** AFK's sheet while it's open: turning the project on wakes a sweep on the host, so the task it
 * claims (or the reason GitHub refused it) lands after the switch's own answer. */
export const AFK_MS = 5_000

/** The Code and Routines lists. */
export const LIST_MS = 60_000
/** Whether the host can dictate. */
export const DICTATION_INFO_MS = 5 * 60_000
