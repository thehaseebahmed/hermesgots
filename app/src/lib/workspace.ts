import { answerApproval } from "@/lib/chat"
import { db, getMessages, type Conversation, type SessionMode } from "@/lib/db"
import {
  ensureWorkspace,
  getSessionPrs,
  getWorkspace,
  HermesError,
  removeWorkspace,
  setWorkspaceMode,
  type KeptWorktree,
  type LiveRunStatus,
  type SessionWorkspace,
} from "@/lib/hermes"

/**
 * A project session's workspace: the worktrees the Memento plugin made for it on the Hermes host
 * (one per repo of the project), its permission mode and its pull requests. The plugin holds all
 * of it; this keeps a local copy.
 */

/** Bots whose plugin has no workspace routes (an older plugin), and when they were last asked. */
const unsupported = new Map<string, number>()
const RETRY_MS = 5 * 60 * 1000
/** How long a known pull request is trusted before it's read again. */
const PR_MS = 30_000

export type SessionState = "working" | "waiting" | "idle" | "draft" | "resolved"

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
  if (!conversation?.projectId || !profile?.apiKey || !profile.pluginChats) return null
  return { conversation, profile, key: `${profile.baseUrl}\n${profile.apiKey}` }
}

const cooling = (key: string) => Date.now() - (unsupported.get(key) ?? -Infinity) < RETRY_MS

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
  })
}

/**
 * Gets the session its worktrees (made on the first turn, named after `task`) and points the
 * agent's tools into the primary one, which has to happen before every turn. Throws only while the
 * session has no worktree yet: afterwards the plugin's own hook restores the pointer on the next
 * tool call.
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
    if (!conversation.worktree) throw error
    return {
      ...conversation.worktree,
      projectId: conversation.projectId!,
      mode: conversation.mode ?? "accept_edits",
      planPending: Boolean(conversation.planPending),
    }
  }
}

/** Reads the session's workspace from the plugin: its mode and whether a plan is waiting. */
export async function refreshWorkspace(conversationId: string) {
  const found = await tracked(conversationId)
  if (!found || cooling(found.key)) return
  let workspace
  try {
    workspace = await getWorkspace(found.profile, found.conversation.hermesSessionId)
  } catch {
    unsupported.set(found.key, Date.now())
    return
  }
  unsupported.delete(found.key)
  await store(conversationId, workspace)
}

/** Reads the branch's pull request in each of the session's repos from the plugin. */
export async function refreshPrs(conversationId: string, { force = false } = {}) {
  const found = await tracked(conversationId)
  if (!found?.conversation.worktree || cooling(found.key)) return
  const { conversation, profile } = found
  const newest = Math.min(...(conversation.prs ?? []).map((pr) => pr.at))
  if (!force && conversation.prs?.length && Date.now() - newest < PR_MS) return
  let prs
  try {
    prs = await getSessionPrs(profile, conversation.hermesSessionId)
  } catch {
    unsupported.set(found.key, Date.now())
    return
  }
  unsupported.delete(found.key)
  const at = Date.now()
  await db.conversations.update(conversationId, { prs: prs.map((pr) => ({ ...pr, at })) })
}

/**
 * Changes the session's permission mode here and on the plugin, which also dismisses a pending
 * plan. Switching to auto answers an approval that's already waiting.
 */
export async function setSessionMode(conversationId: string, mode: SessionMode) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return
  await db.conversations.update(conversationId, { mode, planPending: false })
  const profile = await db.profiles.get(conversation.profileId)
  if (profile?.apiKey && profile.pluginChats) {
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
  if (mode === "auto") {
    const open = (await getMessages(conversationId)).find((m) => m.approval && !m.approval.resolved)
    if (open) await answerApproval(open, "once")
  }
}

/** Asks the plugin to remove the worktrees; it keeps those with uncommitted or unpushed work. */
export async function removeSessionWorkspace(
  conversationId: string,
): Promise<{ removed: boolean; kept: KeptWorktree[]; error?: string }> {
  const found = await tracked(conversationId)
  if (!found?.conversation.worktree) return { removed: false, kept: [] }
  try {
    return await removeWorkspace(found.profile, found.conversation.hermesSessionId)
  } catch (error) {
    return {
      removed: false,
      kept: [],
      error: error instanceof Error ? error.message : "Couldn't reach the plugin.",
    }
  }
}

/**
 * Where a session stands: `live` is what the plugin reports for the server, and `local` what this
 * device sees of its own turn, which is exact here and invisible elsewhere.
 */
export function sessionState(
  conversation: Pick<
    Conversation,
    "resolvedAt" | "planPending" | "draftAt" | "createdAt" | "updatedAt"
  >,
  live?: LiveRunStatus,
  local?: { streaming?: boolean; approval?: boolean },
): SessionState {
  if (conversation.resolvedAt) return "resolved"
  // Saved as a draft and nothing sent since: a turn moves `updatedAt` past `createdAt`.
  if (conversation.draftAt && conversation.updatedAt <= conversation.createdAt) return "draft"
  if (local?.approval || live === "waiting_for_approval" || conversation.planPending)
    return "waiting"
  if (local?.streaming || live === "running") return "working"
  return "idle"
}
