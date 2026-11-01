import { toast } from "sonner"

import { LIBRARY_MS, PR_MS, PR_PENDING_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import { noteFailure } from "@/lib/report"
import { connectionKey, hasServer } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import {
  db,
  prIsLive,
  prKey,
  sessionMode,
  updateConversation,
  type Conversation,
  type Profile,
  type PullRequestRef,
  type SessionMode,
} from "@/lib/db"
import {
  ensureWorkspace,
  getSessionClose,
  getSessionLibrary,
  getSessionPrs,
  getWorkspace,
  hasPluginFeature,
  HermesError,
  closeSession,
  removeWorkspace,
  setWorkspaceMode,
  startSessionClose,
  type HermesProject,
  type HermesProjectFolder,
  type SessionClose,
  type SessionWorkspace,
} from "@/lib/hermes"
import { tellClose } from "@/lib/close-reports"
import { syncNow } from "@/lib/sync"
import { sessionState, type SessionState } from "@/lib/session-work"

/**
 * Where a session stands, from the pure rule in `src/lib/session-work.ts` — a screen keeps reading it
 * from here: `live` is what the plugin reports for the server, `local` what this device sees of its
 * own turn (exact here, invisible elsewhere), and `subagents` how many the host still runs for it.
 */
export { sessionState, type SessionState }

/**
 * A project session's workspace: the worktrees the Gots plugin made for it on the Hermes host
 * (one per repo of the project), its permission mode and its pull requests. The plugin holds all
 * of it; this keeps a local copy.
 */

/** Bots whose plugin has no workspace routes (an older plugin). */
const unsupported = cooldown()

/**
 * When each session's library was last read here: what `LIBRARY_MS` measures. Kept out of the row
 * so a read that found the same count doesn't wake every query the conversation covers.
 */
const libraryRead = new Map<string, number>()
/** When this device last read a session's pull requests — the freshness gate's own clock. */
const prsRead = new Map<string, number>()

/** Whether any of a session's live pull requests still has checks running. */
export const prChecksPending = (prs: PullRequestRef[] | undefined) =>
  (prs ?? []).some((pr) => prIsLive(pr) && pr.checks === "pending")

export const MODE_LABELS: Record<SessionMode, string> = {
  accept_edits: "Accept edits",
  auto: "Auto",
  plan: "Plan",
}

/** The session and its bot, when the bot's plugin can hold its workspace. */
async function tracked(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  // Keyless chats have no session id Hermes knows.
  if (!conversation?.projectId || !profile?.apiKey || profile.disabled) return null
  return { conversation, profile, key: connectionKey(profile) }
}

async function store(conversationId: string, workspace: SessionWorkspace | null) {
  const current = await db.conversations.get(conversationId)
  if (!current) return
  if (!workspace) {
    // The read came back with no workspace of this session's own — the plugin has no record for it,
    // or answered with another session's. A plan already taken from that other session stays on the
    // row otherwise, and the card it draws would approve a file this session never planned.
    if (current.planPending || current.planFile)
      await db.conversations.update(conversationId, { planPending: false, planFile: undefined })
    return
  }
  const next: Partial<Conversation> = {
    mode: workspace.mode,
    worktree: {
      branch: workspace.branch,
      repos: workspace.repos,
      instructions: workspace.instructions,
    },
    planPending: workspace.planPending,
    planFile: workspace.planFile ?? undefined,
    blocked: workspace.blocked ?? undefined,
    pipeline: workspace.pipeline ?? undefined,
  }
  // Read after every turn and catch-up; a write that changes nothing still wakes every query.
  const same = (Object.keys(next) as (keyof Conversation)[]).every(
    (key) => JSON.stringify(current[key]) === JSON.stringify(next[key]),
  )
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  if (!same) await db.conversations.update(conversationId, next)
}

/**
 * Gets the session its worktrees (made on the first turn, named after `task`) and points the
 * agent's tools into the primary one, which has to happen before every turn. Throws while the
 * session has no worktree yet (afterwards the plugin's own hook restores the pointer on the next
 * tool call), and when the plugin refuses the turn: a repo is still being added to the project, a
 * repo the session works in was removed, or the project is archived.
 */
export async function ensureSessionWorkspace(
  conversationId: string,
  task: string,
): Promise<SessionWorkspace | undefined> {
  const found = await tracked(conversationId)
  if (!found) return
  const { conversation, profile } = found
  try {
    const workspace = await ensureWorkspace(profile, conversation.hermesSessionId, {
      projectId: conversation.projectId!,
      task,
      mode: sessionMode(conversation.mode),
    })
    await store(conversationId, workspace)
    return workspace
  } catch (error) {
    if (error instanceof HermesError && error.status === 409) {
      if (conversation.worktree)
        await db.conversations.update(conversationId, { blocked: error.message })
      throw error
    }
    if (!conversation.worktree) throw error
    return {
      ...conversation.worktree,
      projectId: conversation.projectId!,
      mode: sessionMode(conversation.mode),
      planPending: Boolean(conversation.planPending),
      planFile: conversation.planFile ?? null,
      blocked: null,
      pipeline: conversation.pipeline ?? null,
    }
  }
}

/** Reads the session's workspace from the plugin: its mode and whether a plan is waiting. */
export async function refreshWorkspace(conversationId: string) {
  const found = await tracked(conversationId)
  if (!found || unsupported.cooling(found.key)) return
  let workspace
  try {
    workspace = await getWorkspace(
      found.profile,
      found.conversation.hermesSessionId,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
  } catch (error) {
    noteFailure("Reading a session's workspace", error)
    if (await lacksRoute(found.profile, error, "sessions")) unsupported.start(found.key)
    return
  }
  unsupported.clear(found.key)
  await store(conversationId, workspace)
}

/**
 * Reads the session's filed files from the plugin: the count its pill shows. A session with no
 * worktree has no library folder yet, so there is nothing to count.
 */
export async function refreshLibrary(conversationId: string) {
  const found = await tracked(conversationId)
  if (!found?.conversation.worktree || unsupported.cooling(found.key)) return
  const { conversation, profile } = found
  const readAt = libraryRead.get(conversationId) ?? conversation.library?.at ?? 0
  if (Date.now() - readAt < LIBRARY_MS) return
  let library
  try {
    library = await getSessionLibrary(
      profile,
      conversation.hermesSessionId,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
  } catch (error) {
    noteFailure("Reading a session's library", error)
    if (await lacksRoute(profile, error, "sessions")) unsupported.start(found.key)
    return
  }
  unsupported.clear(found.key)
  libraryRead.set(conversationId, Date.now())
  const count = library.folders.reduce((total, folder) => total + folder.files.length, 0)
  const current = conversation.library
  if (current && current.count === count) return
  await db.conversations.update(conversationId, { library: { count, at: Date.now() } })
}

/** Reads the branch's pull request in each of the session's repos from the plugin. */
export async function refreshPrs(conversationId: string, { force = false } = {}) {
  const found = await tracked(conversationId)
  // A discarded session's pull requests stay as it closed them; its branch is gone.
  if (
    !found?.conversation.worktree ||
    found.conversation.discardedAt ||
    unsupported.cooling(found.key)
  )
    return
  const { conversation, profile } = found
  // When this device last read, not when a pull request last moved: `pr.at` carries the move (a
  // Code row's last activity reads it), so the gate keeps its own clock — the way refreshLibrary
  // keeps `libraryRead` beside `library.at`.
  const newest = (conversation.prs ?? []).length
    ? Math.min(...(conversation.prs ?? []).map((pr) => pr.at))
    : 0
  const readAt = prsRead.get(conversationId) ?? newest
  const trusted = prChecksPending(conversation.prs) ? PR_PENDING_MS : PR_MS
  if (!force && conversation.prs?.length && Date.now() - readAt < trusted) return
  let prs
  try {
    prs = await getSessionPrs(
      profile,
      conversation.hermesSessionId,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
  } catch (error) {
    noteFailure("Reading a session's pull requests", error)
    if (await lacksRoute(profile, error, "prs")) unsupported.start(found.key)
    return
  }
  unsupported.clear(found.key)
  prsRead.set(conversationId, Date.now())
  const before = new Map((conversation.prs ?? []).map((pr) => [prKey(pr), pr]))
  // A pull request carries its moment on its own record, and it means the pull request's last
  // move: re-reads with nothing changed write nothing (and stamp nothing), so a row's last
  // activity only follows real updates. Compared per pull request: a session keeps the ones it
  // already finished, so one merge isn't "the newest of its repo became merged" but that pull
  // request's own change.
  const stamped = prs.map((pr) => {
    const old = before.get(prKey(pr))
    const same =
      old &&
      old.state === pr.state &&
      old.checks === pr.checks &&
      old.title === pr.title &&
      old.url === pr.url
    return same ? old : { ...pr, at: Date.now() }
  })
  const previous = conversation.prs ?? []
  const changed =
    stamped.length !== previous.length || stamped.some((pr) => !previous.includes(pr))
  if (changed) await db.conversations.update(conversationId, { prs: stamped })
  // The plugin resolves the session once its pull request merges; the chat list brings that here.
  const wasState = new Map(previous.map((pr) => [prKey(pr), pr.state]))
  const merged = (pr: { repo: string; number: number; state: string }) =>
    pr.state === "merged" && wasState.get(prKey(pr)) !== "merged"
  if (!conversation.resolvedAt && prs.some(merged)) void syncNow()
}

/**
 * Changes the session's permission mode here and on the plugin, which also dismisses a pending
 * plan and, switching to Auto, answers an approval that's already waiting.
 */
export async function setSessionMode(conversationId: string, mode: SessionMode) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return
  await updateConversation(conversationId, { mode, planPending: false })
  await pushSessionMode(conversation, mode)
}

/** Adopts a mode pulled from another device and pushes it to the plugin, as a pick does. */
export async function adoptSessionMode(conversationId: string, mode: SessionMode) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return
  await pushSessionMode(conversation, mode)
}

/** Tells the plugin which mode its session runs in, the way a pick here does. */
async function pushSessionMode(conversation: Conversation, mode: SessionMode) {
  const profile = await db.profiles.get(conversation.profileId)
  if (!profile?.apiKey || profile.disabled) return
  try {
    await store(
      conversation.id,
      await setWorkspaceMode(profile, conversation.hermesSessionId, mode),
    )
  } catch (error) {
    // Before the first turn there's nothing on the plugin yet; the first turn carries the mode.
    if (!(error instanceof HermesError && error.status === 404)) throw error
  }
}

/**
 * Asks the host to close a session on Delete or Discard (ADR 0075): its worktrees go, except those
 * with uncommitted or unpushed work, and each repository's open pull request is closed and its
 * pushed branch deleted on GitHub.
 *
 * A host that advertises `closes` records the close and answers at once, so the row can move at the
 * tap; this then follows that close while the device is still here, telling what it ended with —
 * a device that leaves is told by Code's own screen instead. A plugin from before the route gets
 * the synchronous call, which holds the request and answers with what it couldn't do.
 */
export async function closeSessionWork(conversation: Conversation, profile: Profile): Promise<void> {
  const session = conversation.hermesSessionId
  if (!session || !hasServer(profile) || profile.disabled) return
  if (await hasPluginFeature(profile, "closes")) {
    try {
      const asked = await startSessionClose(profile, session)
      if (asked.state === "closing") void followClose(conversation.id, profile, asked)
      else void markClosed(conversation.id, asked.results)
      tellClose(profile, asked)
    } catch (error) {
      // The ask may have landed with only its answer lost — the network going as the dialog closes,
      // which is exactly when this runs. Asking again would be a second removal of the same trees,
      // so this reports and stops; the host's own record answers the next read.
      noteFailure("Asking the host to close a session", error)
    }
    return
  }
  if (!conversation.worktree) return
  try {
    const { kept, results, error } = await closeSession(profile, session)
    await markClosed(conversation.id, results)
    // A host without the recorded close answers with its report here, and this is the only chance
    // to tell it: the same words, told the same once.
    tellClose(profile, {
      sessionId: session,
      state: "done",
      startedAt: Date.now(),
      endedAt: Date.now(),
      repos: conversation.worktree.repos.map((repo) => repo.name),
      removed: !kept.length,
      kept,
      results,
      error,
    })
    return
  } catch (error) {
    // Only a plugin that has no sync close at all falls through to the worktrees alone: a timeout or
    // a lost answer leaves a host that is already working, and removing the trees again would race.
    if (!(await lacksRoute(profile, error, "close"))) {
      noteFailure("Closing a session", error)
      return
    }
  }
  try {
    const { kept } = await removeWorkspace(profile, session)
    for (const tree of kept)
      toast.info(
        `Kept ${tree.name}: it has ${tree.reason === "dirty" ? "uncommitted" : "unpushed"} changes.`,
      )
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Couldn't reach the plugin.")
  }
}

/** How long after asking this device keeps reading a close, and how often. */
const CLOSE_READ_MS = 5_000
const CLOSE_WAIT_MS = 30_000

/**
 * Reads the close asked for until it ends, then tells it: the report the button's own device gets
 * while it is still here. Give up quietly after a while — Code reads the report later anyway.
 */
async function followClose(
  conversationId: string,
  profile: Profile,
  started: SessionClose,
) {
  const until = Date.now() + CLOSE_WAIT_MS
  let close = started
  while (close.state === "closing" && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, CLOSE_READ_MS))
    try {
      close = await getSessionClose(profile, started.sessionId)
    } catch (error) {
      // One lost read is not a lost close: the next look may answer, and Code reads it either way.
      noteFailure("Reading a session's close", error)
      continue
    }
  }
  if (close.state !== "done") return
  await markClosed(conversationId, close.results)
  tellClose(profile, close)
}

/** A close's own results onto the row: the pull requests it closed, where the session is still here. */
async function markClosed(
  conversationId: string,
  results: { name: string; closed: number | null }[],
) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation?.prs) return
  // A close names one pull request ("name#number"): a session that shipped more than once keeps the
  // ones already finished, so only the live one changes state here.
  const closed = new Set(
    results.filter((r) => r.closed !== null).map((r) => `${r.name}#${r.closed}`),
  )
  if (!closed.size) return
  await db.conversations.update(conversationId, {
    prs: conversation.prs.map((pr) => (closed.has(prKey(pr)) ? { ...pr, state: "closed" } : pr)),
  })
}

const PLAN_GO_AHEAD = "Go ahead with the plan"

/** What approving a plan sends: the saved plan's checkpoints, each committed, or just a go-ahead. */
export function planApprovalMessage(planFile: string | undefined) {
  if (!planFile) return `${PLAN_GO_AHEAD}.`
  return (
    `${PLAN_GO_AHEAD} in \`${planFile}\`. Work through its checkpoints in order and commit ` +
    "each one on this branch with the commit message it names, then open the pull request."
  )
}

/** Matched on its text so a copy loaded from the transcript, on any device, reads the same. */
export const isPlanApproval = (text: string) =>
  text === planApprovalMessage(undefined) || text.startsWith(PLAN_GO_AHEAD + " in `")

export interface RepoRef {
  name: string
  /** The session's own branch, or else the one a new session's branch starts from (`base`). */
  branch?: string | null
  base?: boolean
}

/** A repo as `user/repo`; any other folder by its label or name, never its path. */
export function folderName(folder: HermesProjectFolder) {
  return (
    folder.repo ?? folder.label ?? folder.path.split(/[\\/]/).filter(Boolean).at(-1) ?? folder.path
  )
}

/** The repos a session of the project works in, primary first; not ones being added or removed. */
export function projectRepos(project: HermesProject): RepoRef[] {
  return project.folders
    .filter((folder) => folder.git && !folder.status)
    .map((folder) => ({ name: folderName(folder), branch: folder.branch, base: true }))
}
