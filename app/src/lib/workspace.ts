import { answerApproval } from "@/lib/chat"
import { db, getMessages, type Conversation, type SessionMode } from "@/lib/db"
import {
  ensureWorkspace,
  getSessionPr,
  getWorkspace,
  HermesError,
  removeWorkspace,
  setWorkspaceMode,
  type LiveRunStatus,
  type SessionWorkspace,
} from "@/lib/hermes"

/**
 * A project session's workspace: the worktree the Memento plugin made for it on the Hermes host,
 * its permission mode and its pull request. The plugin holds all of it; this keeps a local copy.
 */

/** Bots whose plugin has no workspace routes (an older plugin), and when they were last asked. */
const unsupported = new Map<string, number>()
const RETRY_MS = 5 * 60 * 1000
/** How long a known pull request is trusted before it's read again. */
const PR_MS = 30_000

export type SessionState = "working" | "waiting" | "idle" | "resolved"

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
    worktree: { path: workspace.path, branch: workspace.branch },
    planPending: workspace.planPending,
  })
}

/**
 * Gets the session its worktree (made on the first turn, named after `task`) and points the
 * agent's tools into it, which has to happen before every turn. Throws only while the session has
 * no worktree yet: afterwards the plugin's own hook restores the pointer on the next tool call.
 */
export async function ensureSessionWorkspace(
  conversationId: string,
  task: string,
): Promise<SessionWorkspace | undefined> {
  const found = await tracked(conversationId)
  const repoRoot = found?.conversation.repoRoot
  if (!found || !repoRoot) return
  const { conversation, profile } = found
  try {
    const workspace = await ensureWorkspace(profile, conversation.hermesSessionId, {
      projectId: conversation.projectId!,
      repoRoot,
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
      repoRoot,
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

/** Reads the worktree branch's pull request from the plugin. */
export async function refreshPr(conversationId: string, { force = false } = {}) {
  const found = await tracked(conversationId)
  if (!found?.conversation.worktree || cooling(found.key)) return
  const { conversation, profile } = found
  if (!force && conversation.pr && Date.now() - conversation.pr.at < PR_MS) return
  let pr
  try {
    pr = await getSessionPr(profile, conversation.hermesSessionId)
  } catch {
    unsupported.set(found.key, Date.now())
    return
  }
  unsupported.delete(found.key)
  await db.conversations.update(conversationId, { pr: pr ? { ...pr, at: Date.now() } : null })
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

/** Asks the plugin to remove the worktree; it keeps one that has uncommitted or unpushed work. */
export async function removeSessionWorkspace(
  conversationId: string,
): Promise<{ removed: boolean; reason?: "dirty" | "unpushed" | "missing"; error?: string }> {
  const found = await tracked(conversationId)
  if (!found?.conversation.worktree) return { removed: false, reason: "missing" }
  try {
    return await removeWorkspace(found.profile, found.conversation.hermesSessionId)
  } catch (error) {
    return {
      removed: false,
      error: error instanceof Error ? error.message : "Couldn't reach the plugin.",
    }
  }
}

/**
 * Where a session stands: `live` is what the plugin reports for the server, and `local` what this
 * device sees of its own turn, which is exact here and invisible elsewhere.
 */
export function sessionState(
  conversation: Pick<Conversation, "resolvedAt" | "planPending">,
  live?: LiveRunStatus,
  local?: { streaming?: boolean; approval?: boolean },
): SessionState {
  if (conversation.resolvedAt) return "resolved"
  if (local?.approval || live === "waiting_for_approval" || conversation.planPending)
    return "waiting"
  if (local?.streaming || live === "running") return "working"
  return "idle"
}
