import { PR_MS, PR_PENDING_MS } from "@/lib/freshness"
import { noteFailure } from "@/lib/report"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db, type Conversation, type PullRequestRef, type SessionMode } from "@/lib/db"
import {
  ensureWorkspace,
  getSessionPrs,
  getWorkspace,
  HermesError,
  closeSession,
  removeWorkspace,
  setWorkspaceMode,
  type HermesProject,
  type HermesProjectFolder,
  type KeptWorktree,
  type LiveRunStatus,
  type SessionWorkspace,
} from "@/lib/hermes"
import { syncNow } from "@/lib/sync"

/**
 * A project session's workspace: the worktrees the Memento plugin made for it on the Hermes host
 * (one per repo of the project), its permission mode and its pull requests. The plugin holds all
 * of it; this keeps a local copy.
 */

/** Bots whose plugin has no workspace routes (an older plugin). */
const unsupported = cooldown()

/** Whether any of a session's pull requests still has checks running. */
export const prChecksPending = (prs: PullRequestRef[] | undefined) =>
  (prs ?? []).some((pr) => pr.state !== "merged" && pr.checks === "pending")

export type SessionState = "working" | "waiting" | "idle" | "resolved" | "discarded"

export const MODE_LABELS: Record<SessionMode, string> = {
  accept_edits: "Accept edits",
  auto: "Auto",
  plan: "Plan",
  theseus: "Theseus",
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
  if (!workspace) return
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  await db.conversations.update(conversationId, {
    mode: workspace.mode,
    worktree: {
      branch: workspace.branch,
      repos: workspace.repos,
      instructions: workspace.instructions,
    },
    planPending: workspace.planPending,
    planFile: workspace.planFile ?? undefined,
    blocked: workspace.blocked ?? undefined,
  })
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
      mode: conversation.mode,
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
      mode: conversation.mode ?? "accept_edits",
      planPending: Boolean(conversation.planPending),
      planFile: conversation.planFile ?? null,
      blocked: null,
    }
  }
}

/** Reads the session's workspace from the plugin: its mode and whether a plan is waiting. */
export async function refreshWorkspace(conversationId: string) {
  const found = await tracked(conversationId)
  if (!found || unsupported.cooling(found.key)) return
  let workspace
  try {
    workspace = await getWorkspace(found.profile, found.conversation.hermesSessionId)
  } catch (error) {
    noteFailure("Reading a session's workspace", error)
    if (await lacksRoute(found.profile, error, "sessions")) unsupported.start(found.key)
    return
  }
  unsupported.clear(found.key)
  await store(conversationId, workspace)
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
  const newest = Math.min(...(conversation.prs ?? []).map((pr) => pr.at))
  const trusted = prChecksPending(conversation.prs) ? PR_PENDING_MS : PR_MS
  if (!force && conversation.prs?.length && Date.now() - newest < trusted) return
  let prs
  try {
    prs = await getSessionPrs(profile, conversation.hermesSessionId)
  } catch (error) {
    noteFailure("Reading a session's pull requests", error)
    if (await lacksRoute(profile, error, "prs")) unsupported.start(found.key)
    return
  }
  unsupported.clear(found.key)
  const at = Date.now()
  await db.conversations.update(conversationId, { prs: prs.map((pr) => ({ ...pr, at })) })
  // The plugin resolves the session once its pull request merges; the chat list brings that here.
  const merged = (pr: { repo: string; state: string }) =>
    pr.state === "merged" &&
    conversation.prs?.find((old) => old.repo === pr.repo)?.state !== "merged"
  if (!conversation.resolvedAt && prs.some(merged)) void syncNow()
}

/**
 * Changes the session's permission mode here and on the plugin, which also dismisses a pending
 * plan and, switching to Auto, answers an approval that's already waiting.
 */
export async function setSessionMode(conversationId: string, mode: SessionMode) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return
  await db.conversations.update(conversationId, { mode, planPending: false })
  const profile = await db.profiles.get(conversation.profileId)
  if (profile?.apiKey && !profile.disabled) {
    try {
      await store(
        conversationId,
        await setWorkspaceMode(profile, conversation.hermesSessionId, mode),
      )
    } catch (error) {
      // Before the first turn there's nothing on the plugin yet; the first turn carries the mode.
      if (!(error instanceof HermesError && error.status === 404)) throw error
    }
  }
}

/**
 * Ends a session being deleted or discarded on the plugin: its worktrees go (the plugin keeps those
 * with uncommitted or unpushed work), and its pull requests and pushed branches are closed and
 * deleted on GitHub. What it couldn't do comes back as `errors`.
 */
export async function closeSessionWork(
  conversationId: string,
): Promise<{ kept: KeptWorktree[]; errors: string[] }> {
  const found = await tracked(conversationId)
  if (!found?.conversation.worktree) return { kept: [], errors: [] }
  const { profile, conversation } = found
  const named = conversation.worktree!.repos.length > 1
  try {
    const { kept, results } = await closeSession(profile, conversation.hermesSessionId)
    const closed = new Set(results.filter((r) => r.closed !== null).map((r) => r.name))
    if (closed.size && conversation.prs)
      await db.conversations.update(conversationId, {
        prs: conversation.prs.map((pr) => (closed.has(pr.repo) ? { ...pr, state: "closed" } : pr)),
      })
    return {
      kept,
      errors: results
        .filter((result) => result.error)
        .map((result) => (named ? `${result.name}: ${result.error}` : result.error!)),
    }
  } catch {
    // A plugin from before 0.20 can only remove the worktrees.
  }
  try {
    return { kept: (await removeWorkspace(profile, conversation.hermesSessionId)).kept, errors: [] }
  } catch (error) {
    return {
      kept: [],
      errors: [error instanceof Error ? error.message : "Couldn't reach the plugin."],
    }
  }
}

/**
 * Where a session stands: `live` is what the plugin reports for the server, and `local` what this
 * device sees of its own turn, which is exact here and invisible elsewhere.
 */
export function sessionState(
  conversation: Pick<Conversation, "resolvedAt" | "discardedAt" | "planPending">,
  live?: LiveRunStatus,
  local?: { streaming?: boolean; waiting?: boolean },
): SessionState {
  if (conversation.discardedAt) return "discarded"
  if (conversation.resolvedAt) return "resolved"
  if (local?.waiting || live === "waiting_for_approval" || conversation.planPending)
    return "waiting"
  if (local?.streaming || live === "running") return "working"
  return "idle"
}

/** A pull request still open (a draft included) is a session waiting to be reviewed and merged. */
export const hasOpenPr = (conversation: Pick<Conversation, "prs">) =>
  (conversation.prs ?? []).some((pr) => pr.state === "open" || pr.state === "draft")

/**
 * Where a session stands as the project screen groups it: an idle session left with an open pull
 * request waits to be reviewed and merged (`prTick`), unless its checks are still running, which is
 * work it has left to do.
 */
export function sessionGroup(
  conversation: Pick<Conversation, "resolvedAt" | "discardedAt" | "planPending" | "prs">,
  live?: LiveRunStatus,
  local?: { streaming?: boolean; waiting?: boolean },
): { state: SessionState; prTick: boolean } {
  const state = sessionState(conversation, live, local)
  if (state !== "idle" || !hasOpenPr(conversation)) return { state, prTick: false }
  return prChecksPending(conversation.prs)
    ? { state: "working", prTick: false }
    : { state: "waiting", prTick: true }
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
export const isPlanApproval = (text: string) => text.startsWith(PLAN_GO_AHEAD)

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
