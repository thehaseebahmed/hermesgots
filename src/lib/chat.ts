import {
  db,
  getActiveProfile,
  getMessages,
  type ApprovalChoice,
  type Message,
  type MessageStats,
  type ToolEvent,
  updateConversation,
} from "@/lib/db"
import {
  getSessionTitle,
  HermesError,
  respondToApproval,
  streamChat,
  type ChatMessage,
  type HermesConfig,
  type TurnUsage,
} from "@/lib/hermes"
import { randomId } from "@/lib/utils"

/**
 * Sends a turn to Hermes and persists the streamed reply into IndexedDB as it arrives.
 * The UI renders straight from Dexie live queries, so it never holds stream state itself.
 */

const FLUSH_INTERVAL_MS = 50
/** Hermes upgrades a placeholder title on later turns, up to the third. */
const TITLED_TURNS = 3
/** Hermes titles with a model call in the background, which can land after the reply ends. */
const TITLE_CHECKS_MS = [0, 3000, 10000]
const controllers = new Map<string, AbortController>()
/** In-flight reply drafts by message id, so approval answers land in the draft being flushed. */
const activeDrafts = new Map<string, { draft: Message; touch: () => void }>()

function estimateTokens(text: string) {
  return Math.max(1, Math.round(text.length / 4))
}

function titleFrom(text: string) {
  const line = text.trim().split("\n")[0]
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line || "New chat"
}

/** Swaps the first-line title for the one Hermes generated, unless the user renamed the chat. */
async function syncTitle(conversationId: string, config: HermesConfig, sessionId: string) {
  for (const delay of TITLE_CHECKS_MS) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay))
    const title = await getSessionTitle(config, sessionId)
    const conversation = await db.conversations.get(conversationId)
    if (!conversation || conversation.titleEdited) return
    if (title && title !== conversation.title)
      await updateConversation(conversationId, { title })
  }
}

/** A chat's profile, or the active one if its profile has gone. */
async function profileFor(profileId?: string) {
  return (profileId && (await db.profiles.get(profileId))) || getActiveProfile()
}

/** `queuedId` sends a queued message, keeping its id so the bubble doesn't remount. */
export async function sendMessage(conversationId: string, text: string, queuedId?: string) {
  const content = text.trim()
  if (!content || controllers.has(conversationId)) return

  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return
  const profile = await profileFor(conversation.profileId)
  if (!profile) return

  const history = await getMessages(conversationId)
  const now = Date.now()
  const userMessage: Message = {
    id: queuedId ?? randomId(),
    conversationId,
    role: "user",
    content,
    status: "done",
    createdAt: now,
  }
  const reply: Message = {
    id: randomId(),
    conversationId,
    role: "assistant",
    content: "",
    tools: [],
    status: "streaming",
    createdAt: now + 1,
  }

  await db.transaction("rw", db.messages, db.conversations, async () => {
    if (queuedId) await db.messages.delete(queuedId)
    await db.messages.bulkAdd([userMessage, reply])
    await updateConversation(conversationId, {
      updatedAt: now,
      ...(history.length === 0 && !conversation.titleEdited ? { title: titleFrom(content) } : {}),
    })
  })

  const transcript: ChatMessage[] = [...history, userMessage]
    .filter((m) => m.status === "done" || (m.role === "assistant" && m.content))
    .map((m) => ({ role: m.role, content: m.content }))

  const controller = new AbortController()
  controllers.set(conversationId, controller)

  // Mutable working copy; flushed to Dexie on a timer so token deltas don't hammer IndexedDB.
  const draft = { ...reply, tools: [] as ToolEvent[] }
  let dirty = false
  let firstTokenAt: number | null = null
  const flush = async () => {
    if (!dirty) return
    dirty = false
    const { id: _id, ...changes } = draft
    await db.messages.update(reply.id, changes)
  }
  const timer = window.setInterval(flush, FLUSH_INTERVAL_MS)
  const touch = () => {
    dirty = true
  }
  activeDrafts.set(reply.id, { draft, touch })

  const config = { baseUrl: profile.baseUrl, apiKey: profile.apiKey }
  let usage: TurnUsage | undefined
  try {
    const result = await streamChat(
      config,
      {
        model: profile.model,
        messages: transcript,
        sessionId: conversation.hermesSessionId,
        signal: controller.signal,
      },
      {
        onContent(delta) {
          firstTokenAt ??= Date.now()
          draft.content += delta
          draft.statusText = undefined
          touch()
        },
        onReasoning(delta) {
          firstTokenAt ??= Date.now()
          draft.reasoning = (draft.reasoning ?? "") + delta
          touch()
        },
        onStatus(text) {
          draft.statusText = text
          touch()
        },
        onTool(event) {
          const existing = draft.tools.find((t) => t.toolCallId === event.toolCallId)
          if (existing) {
            existing.status = event.status
            if (event.status === "completed") existing.endedAt = Date.now()
          } else {
            draft.tools.push({
              toolCallId: event.toolCallId,
              tool: event.tool,
              emoji: event.emoji,
              label: event.label ?? event.tool,
              status: event.status,
              startedAt: Date.now(),
              contentOffset: draft.content.length,
            })
          }
          draft.tools = [...draft.tools]
          touch()
        },
        onApproval(event) {
          draft.approval = {
            runId: event.run_id,
            command: event.command,
            description: event.description,
            choices: event.choices?.length ? event.choices : ["once", "deny"],
            contentOffset: draft.content.length,
            requestedAt: Date.now(),
          }
          touch()
        },
      },
    )
    usage = result.usage
    draft.status = "done"
  } catch (error) {
    if (controller.signal.aborted) {
      draft.status = "stopped"
    } else {
      draft.status = "error"
      draft.statusText =
        error instanceof HermesError ? error.message : "Something went wrong talking to Hermes."
    }
  } finally {
    window.clearInterval(timer)
    controllers.delete(conversationId)
    activeDrafts.delete(reply.id)
    const endedAt = Date.now()
    draft.tools = draft.tools.map((t) =>
      t.status === "running" ? { ...t, status: "completed", endedAt } : t,
    )
    if (draft.approval && !draft.approval.resolved) {
      draft.approval = { ...draft.approval, resolved: "expired" }
    }
    if (draft.status !== "error") draft.statusText = undefined
    if (draft.content || usage) {
      // Hermes's counts when it sent them; a stopped turn never gets them, so estimate.
      const tokens = usage?.completionTokens || estimateTokens(draft.content)
      const toolsUsed = draft.tools.length > 0
      const writingMs = Math.max(1, endedAt - (firstTokenAt ?? endedAt))
      const stats: MessageStats = {
        tokens,
        estimated: !usage?.completionTokens,
        tokensPerSecond: toolsUsed ? undefined : Math.round(tokens / (writingMs / 1000)),
        durationMs: endedAt - reply.createdAt,
        promptTokens: usage?.promptTokens || undefined,
        toolsUsed,
      }
      draft.stats = stats
    }
    dirty = true
    await flush()
    await updateConversation(conversationId, { updatedAt: endedAt })
  }
  if (draft.status !== "done") return
  // Hermes only keys the session by our id when the profile has an API key.
  const turn = history.filter((m) => m.role === "user" && m.status === "done").length + 1
  if (config.apiKey && turn <= TITLED_TURNS) {
    void syncTitle(conversationId, config, conversation.hermesSessionId)
  }
  // A stop or an error pauses the queue: the user probably wants to look before it carries on.
  await sendNextQueued(conversationId)
}

/** Holds a message until the current reply finishes. */
export async function queueMessage(conversationId: string, text: string) {
  const content = text.trim()
  if (!content) return
  await db.messages.add({
    id: randomId(),
    conversationId,
    role: "user",
    content,
    status: "queued",
    createdAt: Date.now(),
  })
}

export async function sendNextQueued(conversationId: string) {
  const next = (await getMessages(conversationId)).find((m) => m.status === "queued")
  if (next) await sendMessage(conversationId, next.content, next.id)
}

export async function removeQueued(id: string) {
  await db.messages.delete(id)
}

export function stopMessage(conversationId: string) {
  controllers.get(conversationId)?.abort()
}

export async function answerApproval(message: Message, choice: ApprovalChoice) {
  if (!message.approval) return
  const conversation = await db.conversations.get(message.conversationId)
  const profile = await profileFor(conversation?.profileId)
  if (!profile) return
  await respondToApproval(
    { baseUrl: profile.baseUrl, apiKey: profile.apiKey },
    message.approval.runId,
    choice,
  )
  const active = activeDrafts.get(message.id)
  if (active?.draft.approval) {
    active.draft.approval = { ...active.draft.approval, resolved: choice }
    active.touch()
  } else {
    await db.messages.update(message.id, { approval: { ...message.approval, resolved: choice } })
  }
}

/** Replies left "streaming" by a closed tab can never finish; mark them stopped on startup. */
export async function recoverInterruptedMessages() {
  await db.messages
    .filter((m) => m.status === "streaming")
    .modify({ status: "stopped", statusText: undefined })
}
