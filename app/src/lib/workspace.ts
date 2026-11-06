import { toast } from "sonner"

import { LIBRARY_MS, PR_QUIET_MS, PR_MS, PR_PENDING_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import { noteFailure } from "@/lib/report"
import { connectionKey, hasServer } from "@/lib/connection"
import { closedSession } from "@/lib/session-work"
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
  getSessionPrsBatch,
  getWorkspace,
  getPluginFeatureList,
  hasPluginFeature,
  HermesError,
  closeSession,
  removeWorkspace,
  setWorkspaceMode,
  startSessionClose,
  type HermesProject,
  type HermesProjectFolder,
  type PullRequest,
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
const prsReadAt = new Map<string, number>()

/** Whether any of a session's live pull requests still has checks running. */
export const prChecksPending = (prs: PullRequestRef[] | undefined) =>
  (prs ?? []).some((pr) => prIsLive(pr) && pr.checks === "pending")

export const MODE_LABELS: Record<SessionMode, string> = {
  accept_edits: "Accept edits",
  plan: "Plan",
}

type SessionTarget = { conversation: Conversation; profile: Profile; key: string }

/**
 * The sessions a list can read, and their bots, in two round trips rather than two a row: a screen's
 * tick asks about hundreds of rows, and `get` per row per tick measured 452 transactions to ask 24.
 */
async function targetsOf(conversationIds: string[]): Promise<SessionTarget[]> {
  const rows = await db.conversations.bulkGet(conversationIds)
  // Keyless chats have no session id Hermes knows.
  const wanted = rows.filter((row): row is Conversation => Boolean(row?.projectId))
  if (!wanted.length) return []
  const profiles = new Map(
    (await db.profiles.bulkGet([...new Set(wanted.map((row) => row.profileId))]))
      .filter((profile): profile is Profile => Boolean(profile?.apiKey && !profile.disabled))
      .map((profile) => [profile.id, profile]),
  )
  return wanted.flatMap((conversation) => {
    const profile = profiles.get(conversation.profileId)
    return profile ? [{ conversation, profile, key: connectionKey(profile) }] : []
  })
}

/** The session and its bot, when the bot's plugin can hold its workspace. */
async function tracked(conversationId: string): Promise<SessionTarget | null> {
  const [found] = await targetsOf([conversationId])
  return found ?? null
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

/** What a read answered: the row stored, the host failed it, or there was nothing to ask. */
type ReadAnswer = "read" | "failed" | "none"

/**
 * Reads the worktrees of a whole screen's sessions, a few at a time. A host working a turn answers
 * none of them for a while, and ten reads that wait fifteen seconds each are ten sockets the
 * transcript's own read is then queued behind.
 */
export async function refreshWorkspaces(conversationIds: string[]) {
  for (let at = 0; at < conversationIds.length; at += PRS_READS_AT_ONCE) {
    const read = conversationIds.slice(at, at + PRS_READS_AT_ONCE).map((id) => refreshWorkspace(id))
    // Reads that couldn't be made at all say nothing about the host; reads that were made and failed
    // say the host isn't answering, and the rest of the list waits a tick rather than sitting on
    // sockets that will time out one by one.
    const answered = await Promise.all(read)
    if (!answered.includes("read") && answered.includes("failed")) return
  }
}

/**
 * Reads the session's workspace from the plugin: its mode and whether a plan is waiting. The answer
 * separates a read that failed from one there was nothing to make — a closed plugin, no record, a
 * bot already cooling — because only the first says anything about the host.
 */
export async function refreshWorkspace(conversationId: string): Promise<ReadAnswer> {
  const found = await tracked(conversationId)
  if (!found || unsupported.cooling(found.key)) return "none"
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
    return "failed"
  }
  unsupported.clear(found.key)
  await store(conversationId, workspace)
  return "read"
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

/** Joins the read already out for this session, or starts one. */
export function refreshPrs(conversationId: string, { force = false } = {}) {
  const pending = prsInFlight.get(conversationId)
  if (pending) return pending
  const read = readPrs(conversationId, force)
  trackInFlight([conversationId], read)
  return read
}

/**
 * Reads every named session's pull requests in one request per bot, the way the Code screen asks
 * after the sessions it lists: nine rows were nine requests, each a chain of calls on the host.
 * A bot whose plugin predates the batch answers its sessions one at a time, as it always did.
 */
export async function refreshPrsOf(conversationIds: string[], { force = false } = {}) {
  const found = (await targetsOf(conversationIds)).filter(prsReadable)
  // The rows read longest ago first, so a tick of any size takes the stalest and the rest wait
  // their turn rather than all of them being asked past a deadline that can't reach them.
  const asked = (id: string) => prsAskedAt.get(id) ?? prsReadAt.get(id) ?? 0
  // A closed session's branch is done moving as far as the list is concerned: reading it again is
  // the session's own screen's job, when the user opens it.
  const due = found
    .filter((one) => !closedSession(one.conversation))
    .filter((one) => force || dueForPrs(one.conversation))
    .sort((a, b) => asked(a.conversation.id) - asked(b.conversation.id))
  const groups = new Map<string, { profile: Profile; rows: Conversation[] }>()
  for (const one of due) {
    const group = groups.get(one.key) ?? { profile: one.profile, rows: [] }
    // A bot's rows are one request with one deadline, so the cap is a bot's rows rather than the
    // call's: counted across bots, a bot far down the order would spend several ticks with none.
    if (group.rows.length >= PRS_TICK_MAX) continue
    group.rows.push(one.conversation)
    groups.set(one.key, group)
  }
  await Promise.all(
    [...groups.values()].map(async ({ profile, rows }) => {
      const key = connectionKey(profile)
      // Stamped as the rows go into a request, whether or not the host answers for them: a row left
      // unread is not the row the next tick takes first, or one unanswerable session starves the
      // list. A tick that asks nothing at all stamps nothing, so a quiet bot's rows keep their turn.
      const asked = () => {
        for (const row of rows) prsAskedAt.set(row.id, Date.now())
      }
      const oneAtATime = async () => {
        for (let at = 0; at < rows.length; at += PRS_READS_AT_ONCE) {
          // One read that timed out is the host not answering: the rest of the list waits.
          if (prsFailed.cooling(key)) return
          await Promise.all(
            rows.slice(at, at + PRS_READS_AT_ONCE).map((row) => refreshPrs(row.id, { force })),
          )
        }
      }
      if (prsFailed.cooling(key)) return
      // A host that answered no features didn't answer: nine single reads behind its stall is what
      // deepens one, so the rows keep what they hold — and the probe is left alone for a moment too,
      // or every tick pays its fifteen seconds against the same hung socket.
      const features = await getPluginFeatureList(profile)
      if (!features) {
        prsFailed.start(key)
        return
      }
      if (batchUnsupported.cooling(key) || !features.includes("prs_batch")) {
        asked()
        await oneAtATime()
        return
      }
      // The batch's rows join the in-flight map before the request goes out, so a chat asking after
      // one of them while it runs waits on this read rather than paying the chain again. Released
      // before any fallback, which reads those same rows one at a time.
      const settled = deferred()
      trackInFlight(
        rows.map((row) => row.id),
        settled.promise,
      )
      asked()
      let answer
      try {
        answer = await getSessionPrsBatch(
          profile,
          rows.map((row) => row.hermesSessionId),
          AbortSignal.timeout(READ_TIMEOUT_MS),
        )
      } catch (error) {
        settled.release()
        noteFailure("Reading sessions' pull requests", error)
        // A failed batch is a host that couldn't answer, not a route that isn't there: the rows keep
        // what they hold, and this bot is left alone for a moment rather than asked once per session.
        // A route that really isn't there is the other case — it falls back, so it must not also be
        // cooled as a failure, or the fallback it just chose never runs.
        if (await lacksRoute(profile, error, "prs_batch")) batchUnsupported.start(key)
        else prsFailed.start(key)
        return
      }
      prsFailed.clear(key)
      // A session the host named unread — or left out — keeps what this device already holds.
      const unread = new Set(answer.unread)
      try {
        await Promise.all(
          rows
            .filter((row) => !unread.has(row.hermesSessionId) && answer.prs[row.hermesSessionId])
            .map((row) => storePrs(row.id, answer.prs[row.hermesSessionId])),
        )
      } finally {
        settled.release()
      }
    }),
  )
}

/** A promise a caller can settle from outside: the batch's rows wait on the answer, not the request. */
function deferred() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}

/**
 * A session this host can read pull requests for at all: it has a worktree to read a branch from,
 * and its plugin answers the route. Whether it is closed is the caller's to decide — the list
 * leaves a closed row alone, and the session's own screen reads it when the user opens it.
 */
function prsReadable(found: SessionTarget | null): found is SessionTarget {
  return Boolean(found?.conversation.worktree && !unsupported.cooling(found.key))
}

/** When each session's pull requests are already being read: a second ask joins the first. */
const prsInFlight = new Map<string, Promise<void>>()

/** A read joins the rows it answers for, and leaves them together once it settles. */
function trackInFlight(ids: string[], read: Promise<void>) {
  const forget = () => {
    for (const id of ids) if (prsInFlight.get(id) === read) prsInFlight.delete(id)
  }
  for (const id of ids) prsInFlight.set(id, read)
  void read.then(forget, forget)
}

/** Bots whose plugin doesn't answer the batch read, for a while: the per-session route stands in. */
const batchUnsupported = cooldown()

/**
 * How many of a screen's sessions one tick asks about. A list can hold hundreds of rows, and every
 * row in a request is a chain of GitHub calls on that bot: asked all at once, the batch answers past
 * its deadline and the rows it couldn't reach are never refreshed. The rows read longest ago go
 * first, so a screen of any size is read in turn.
 */
export const PRS_TICK_MAX = 24

/** When each row was last asked about, whatever the host answered: a screen this large rotates. */
const prsAskedAt = new Map<string, number>()

/** Bots whose pull-request reads went unanswered, for a while: one read at a time, not nine. */
const prsFailed = cooldown(PR_QUIET_MS)

/** How many per-session reads an older plugin is asked for at once, for a screen's whole list. */
export const PRS_READS_AT_ONCE = 3

/**
 * Whether this device's copy is old enough to read again. The clock is when this device last read,
 * not when a pull request last moved: `pr.at` carries the move (a Code row's last activity reads
 * it), so the gate keeps its own — the way refreshLibrary keeps `libraryRead` beside `library.at`.
 */
function dueForPrs(conversation: Conversation) {
  const newest = (conversation.prs ?? []).length
    ? Math.min(...(conversation.prs ?? []).map((pr) => pr.at))
    : 0
  const readAt = prsReadAt.get(conversation.id) ?? newest
  const trusted = prChecksPending(conversation.prs) ? PR_PENDING_MS : PR_MS
  return !conversation.prs?.length || Date.now() - readAt >= trusted
}

/** Reads the branch's pull request in each of the session's repos from the plugin. */
async function readPrs(conversationId: string, force: boolean) {
  const found = await tracked(conversationId)
  if (!prsReadable(found)) return
  const { conversation, profile } = found
  if (!force && !dueForPrs(conversation)) return
  let prs
  try {
    prs = await getSessionPrs(
      profile,
      conversation.hermesSessionId,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
  } catch (error) {
    noteFailure("Reading a session's pull requests", error)
    // A route that isn't there is the plugin's shape, and an HTTP answer is about this session:
    // only a read with no answer at all is the host, and only that quiets the reads beside it.
    const status = error instanceof HermesError ? error.status : undefined
    if (await lacksRoute(profile, error, "prs")) unsupported.start(found.key)
    else if (!status) prsFailed.start(found.key)
    return
  }
  unsupported.clear(found.key)
  prsFailed.clear(found.key)
  await storePrs(conversationId, prs)
}

/** Keeps what the host answered, stamped per pull request, and resolves a session its PR merged. */
async function storePrs(conversationId: string, prs: PullRequest[]) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return
  prsReadAt.set(conversationId, Date.now())
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
  const changed = stamped.length !== previous.length || stamped.some((pr) => !previous.includes(pr))
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
 * Asks the host to close a session on Delete or Discard (ADR 0080): its worktrees go, except those
 * with uncommitted or unpushed work, and each repository's open pull request is closed and its
 * pushed branch deleted on GitHub.
 *
 * A host that advertises `closes` records the close and answers at once, so the row can move at the
 * tap; this then follows that close while the device is still here, telling what it ended with —
 * a device that leaves is told by Code's own screen instead. A plugin from before the route gets
 * the synchronous call, which holds the request and answers with what it couldn't do.
 */
export async function closeSessionWork(
  conversation: Conversation,
  profile: Profile,
): Promise<void> {
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
async function followClose(conversationId: string, profile: Profile, started: SessionClose) {
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
