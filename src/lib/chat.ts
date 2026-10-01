import {
  db,
  getMessages,
  getSettings,
  type ApprovalChoice,
  type Message,
  type MessageStats,
  type ToolEvent,
} from "@/lib/db"
import { HermesError, respondToApproval, streamChat, type ChatMessage } from "@/lib/hermes"
import { randomId } from "@/lib/utils"

/**
 * Sends a turn to Hermes and persists the streamed reply into IndexedDB as it arrives.
 * The UI renders straight from Dexie live queries, so it never holds stream state itself.
 */

const FLUSH_INTERVAL_MS = 50
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

export async function sendMessage(conversationId: string, text: string) {
  const content = text.trim()
  if (!content || controllers.has(conversationId)) return

  const settings = await getSettings()
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return

  const history = await getMessages(conversationId)
  const now = Date.now()
  const userMessage: Message = {
    id: randomId(),
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
    await db.messages.bulkAdd([userMessage, reply])
    await db.conversations.update(conversationId, {
      updatedAt: now,
      ...(history.length === 0 ? { title: titleFrom(content) } : {}),
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

  const config = { baseUrl: settings.baseUrl, apiKey: settings.apiKey }
  try {
    await streamChat(
      config,
      {
        model: settings.model,
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
    if (draft.content) {
      const tokens = estimateTokens(draft.content)
      const writingMs = Math.max(1, endedAt - (firstTokenAt ?? endedAt))
      const stats: MessageStats = {
        tokens,
        estimated: true,
        tokensPerSecond: Math.round(tokens / (writingMs / 1000)),
        durationMs: endedAt - reply.createdAt,
      }
      draft.stats = stats
    }
    dirty = true
    await flush()
    await db.conversations.update(conversationId, { updatedAt: endedAt })
  }
}

export function stopMessage(conversationId: string) {
  controllers.get(conversationId)?.abort()
}

export async function answerApproval(message: Message, choice: ApprovalChoice) {
  if (!message.approval) return
  const settings = await getSettings()
  await respondToApproval(
    { baseUrl: settings.baseUrl, apiKey: settings.apiKey },
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
