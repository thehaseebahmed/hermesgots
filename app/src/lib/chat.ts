import {
  db,
  getActiveProfile,
  getMessages,
  type ApprovalChoice,
  type ClarifyAnswers,
  type ClarifyRequest,
  type Message,
  type MessageStats,
  type ToolEvent,
  updateConversation,
} from "@/lib/db"
import {
  clarifyQuestions,
  followRun,
  getRun,
  getSessionTitle,
  HermesError,
  labelSession,
  liveRunOf,
  respondToApproval,
  respondToClarify,
  startRun,
  stopRun,
  streamChat,
  supportsRuns,
  type ChatMessage,
  type HermesConfig,
  type RunOutcome,
  type StreamHandlers,
  type TurnUsage,
} from "@/lib/hermes"
import { refreshContext } from "@/lib/context"
import { liveTurn } from "@/lib/history"
import { onTodoTool, refreshTodos } from "@/lib/todos"
import { randomId } from "@/lib/utils"
import { ensureSessionWorkspace, refreshPrs, refreshWorkspace } from "@/lib/workspace"

/**
 * Sends a turn to Hermes and persists the streamed reply into IndexedDB as it arrives.
 * The UI renders straight from Dexie live queries, so it never holds stream state itself.
 */

const FLUSH_INTERVAL_MS = 50
/** How often a run whose events can't be read is polled, with the transcript. */
const POLL_MS = 3000
/** How long after a turn ends before the plugin is asked about it. */
const PLUGIN_SETTLE_MS = 1500
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
    if (title && title !== conversation.title) await updateConversation(conversationId, { title })
  }
}

/** A chat's profile, or the active one if its profile has gone. */
async function profileFor(profileId?: string) {
  return (profileId && (await db.profiles.get(profileId))) || getActiveProfile()
}

type Draft = Message & { tools: ToolEvent[] }

interface Turn {
  conversationId: string
  config: HermesConfig
  draft: Draft
  controller: AbortController
  touch: () => void
  firstTokenAt: number | null
  /** Set when a reply is picked up after a reload, so its timings can't be trusted. */
  resumed: boolean
  /** Stops flushing and saves the draft one last time. */
  close: () => Promise<void>
}

const turns = new Map<string, Turn>()

/** Mutable working copy of a reply, flushed to Dexie on a timer so token deltas don't hammer IndexedDB. */
function openTurn(
  conversationId: string,
  config: HermesConfig,
  reply: Message,
  resumed = false,
): Turn {
  const draft: Draft = { ...reply, tools: [...(reply.tools ?? [])] }
  let dirty = false
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
  const controller = new AbortController()
  const close = async () => {
    window.clearInterval(timer)
    controllers.delete(conversationId)
    turns.delete(conversationId)
    activeDrafts.delete(reply.id)
    dirty = true
    await flush()
  }
  const turn: Turn = {
    conversationId,
    config,
    draft,
    controller,
    touch,
    firstTokenAt: null,
    resumed,
    close,
  }
  controllers.set(conversationId, controller)
  turns.set(conversationId, turn)
  activeDrafts.set(reply.id, { draft, touch })
  return turn
}

/** What Hermes's clarify tool returns for the answers given, so a question reads the same live and from the transcript. */
function clarifyResult(clarify: ClarifyRequest, answers: ClarifyAnswers, outcome: string) {
  return JSON.stringify({
    responses: clarify.questions.map((q) => {
      const answer = answers[q.id] ?? null
      return {
        question: q.question,
        choices_offered: q.choices ?? null,
        status: answer ? "answered" : outcome === "submitted" ? "skipped" : "unanswered",
        user_response: answer,
      }
    }),
    outcome,
  })
}

/**
 * Marks the reply's question answered and gives its `clarify` call the full result: the run
 * stream's own preview of it is cut at 500 characters, and the thread's card reads the call.
 */
function settledClarify(
  message: Pick<Message, "clarify" | "tools">,
  answers: ClarifyAnswers,
  outcome: "submitted" | "cancelled",
) {
  const clarify = { ...message.clarify!, resolved: { answers, outcome } }
  const tools = [...(message.tools ?? [])]
  const at = tools.findLastIndex((t) => t.tool === "clarify")
  if (at >= 0) tools[at] = { ...tools[at], result: clarifyResult(clarify, answers, outcome) }
  return { clarify, tools }
}

function raiseApproval(
  turn: Turn,
  event: { run_id: string; command?: string; description?: string; choices?: ApprovalChoice[] },
) {
  const { draft, touch } = turn
  draft.approval = {
    runId: event.run_id,
    command: event.command,
    description: event.description,
    choices: event.choices?.length ? event.choices : ["once", "deny"],
    contentOffset: draft.content.length,
    requestedAt: Date.now(),
  }
  touch()
}

function streamHandlers(turn: Turn): StreamHandlers {
  const { draft, touch } = turn
  const started = () => {
    turn.firstTokenAt ??= Date.now()
  }
  return {
    onContent(delta) {
      started()
      draft.content += delta
      draft.statusText = undefined
      touch()
    },
    onReasoning(delta) {
      started()
      draft.reasoning = (draft.reasoning ?? "") + delta
      touch()
    },
    onReasoningBlock(text) {
      started()
      draft.reasoning = draft.reasoning ? `${draft.reasoning}\n\n${text}` : text
      touch()
    },
    onStatus(text) {
      draft.statusText = text
      touch()
    },
    onTool(event) {
      const existing = event.toolCallId
        ? draft.tools.find((t) => t.toolCallId === event.toolCallId)
        : draft.tools.find((t) => t.status === "running" && t.tool === event.tool)
      if (existing) {
        existing.status = event.status
        if (event.status !== "running") existing.endedAt = Date.now()
        if (event.status === "completed")
          void onTodoTool(turn.conversationId, existing.tool, event.result)
        // A question's full result is written when it's answered; the stream's preview is cut short.
        if (event.result && !(existing.tool === "clarify" && existing.result))
          existing.result = event.result
      } else {
        // A completion with no start to match still happened; it gets its own card.
        draft.tools.push({
          toolCallId: event.toolCallId ?? `${event.tool}:${Date.now()}`,
          tool: event.tool,
          emoji: event.emoji,
          label: event.label ?? event.tool,
          status: event.status,
          startedAt: Date.now(),
          ...(event.status !== "running" ? { endedAt: Date.now(), result: event.result } : {}),
          contentOffset: draft.content.length,
        })
      }
      draft.tools = [...draft.tools]
      touch()
    },
    onApproval(event) {
      raiseApproval(turn, event)
    },
    // A question is for the user, whatever the mode: nothing answers it for them.
    onClarify(event) {
      if (draft.clarify?.clarifyId === event.clarify_id) return
      const questions = clarifyQuestions(event)
      if (!questions.length) return
      draft.clarify = { runId: event.run_id, clarifyId: event.clarify_id, questions }
      touch()
    },
    // Answered on another device, or a replay of an answer this one gave.
    onClarifyResolved(event) {
      if (!draft.clarify || draft.clarify.clarifyId !== event.clarify_id) return
      if (draft.clarify.resolved && draft.clarify.resolved !== "expired") return
      Object.assign(
        draft,
        settledClarify(
          draft,
          event.answers ?? {},
          event.outcome === "cancelled" ? "cancelled" : "submitted",
        ),
      )
      touch()
    },
  }
}

const RETRY_MS = [1000, 2000, 4000, 8000, 15000]
/** Failed reconnects, counted only while the app is in view and online, before the reply is given up. */
const MAX_VISIBLE_FAILURES = 8

/** Waits `ms`, cut short when the app comes back into view or back online. */
function waitToRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("online", done)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") done()
    }
    const timer = window.setTimeout(done, ms)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("online", done)
    signal.addEventListener("abort", done)
  })
}

/**
 * Network trouble is worth retrying, Hermes turning the request down is not. A stream cut mid-body
 * rejects the read with a bare TypeError.
 */
const retryable = (error: unknown) =>
  !(error instanceof HermesError) ||
  error.status === undefined ||
  error.status >= 500 ||
  [408, 429].includes(error.status)

/**
 * Reads the turn's progress from the session transcript, for a run whose events can't be read (a
 * Hermes whose events stream the browser's CORS check blocks). Keyed sessions only: Hermes holds
 * the transcript under our session id only when a key is sent.
 */
async function transcriptReader(turn: Turn) {
  const { config, draft, touch, conversationId } = turn
  if (!config.apiKey) return undefined
  const conversation = await db.conversations.get(conversationId)
  const messages = await getMessages(conversationId)
  const index = messages.findIndex((m) => m.id === draft.id)
  const user = messages.slice(0, index < 0 ? undefined : index).findLast((m) => m.role === "user")
  if (!conversation || !user) return undefined
  return async () => {
    const reply = await liveTurn(config, conversation.hermesSessionId, user.content).catch(
      () => undefined,
    )
    if (!reply) return
    // Not through onTool: these carry Hermes's own call ids, which history matches later.
    draft.tools = (reply.tools ?? []).map((tool) => {
      if (tool.tool !== "clarify" || tool.result) return tool
      const settled = draft.tools.find((t) => t.toolCallId === tool.toolCallId)
      // The answer can arrive here before Hermes persists the tool's result row.
      return settled?.result ? { ...tool, result: settled.result } : tool
    })
    if (reply.reasoning) draft.reasoning = reply.reasoning
    if (reply.content) draft.content = reply.content
    touch()
  }
}

/**
 * Follows a run to its end through dropped connections: the screen going off, the app being
 * backgrounded, a flaky network. Hermes keeps running it and replays what was missed.
 */
async function trackRun(turn: Turn, runId: string): Promise<RunOutcome> {
  const { config, draft, touch, controller } = turn
  const { signal } = controller
  // Events went missing, so what streamed has gaps; the run's final text replaces it.
  let lost = false
  const handlers = {
    ...streamHandlers(turn),
    onSeq(seq: number) {
      draft.runSeq = seq
      touch()
    },
    onTruncated() {
      lost = true
    },
  }
  // Once Hermes drops the event buffer, only the run's status is left to poll, and the transcript.
  let polling = false
  let raisedFor: string | undefined
  let readTranscript: (() => Promise<void>) | undefined
  let failures = 0
  let errored = false
  for (let attempt = 0; ; attempt++) {
    try {
      if (!polling) {
        const lastSeq = draft.runSeq ?? -1
        const outcome = await followRun(config, runId, { lastSeq, signal }, handlers)
        if (outcome) return { ...outcome, replaceContent: lost }
      } else {
        readTranscript ??= await transcriptReader(turn)
        await readTranscript?.()
      }
      const { outcome, approval, clarify } = await getRun(config, runId, signal)
      if (outcome) return { ...outcome, replaceContent: lost }
      // The events stream carries approval requests; when it can't be read, the run's status holds
      // the one it waits on.
      if (approval) {
        const key = JSON.stringify([approval.command, approval.description])
        if (key !== raisedFor) {
          raisedFor = key
          raiseApproval(turn, approval)
        }
      } else {
        raisedFor = undefined
        if (polling && draft.approval && !draft.approval.resolved) {
          draft.approval = { ...draft.approval, resolved: "expired" }
          touch()
        }
      }
      // A client that can only poll still gets the question: the plugin keeps it on the status.
      if (clarify) handlers.onClarify?.(clarify)
      else if (polling && draft.clarify && !draft.clarify.resolved) {
        draft.clarify = { ...draft.clarify, resolved: "expired" }
        touch()
      }
      failures = 0
      errored = false
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof HermesError && error.status === 404) {
        if (polling) return { status: "interrupted", error: "Hermes no longer has this reply." }
        polling = true
        lost = true
        continue
      }
      // No response to the events request while the run itself answers: the browser blocks the
      // stream (Hermes v2026.9.24 sends it without CORS headers), so retrying it never helps.
      if (!polling && error instanceof HermesError && error.status === undefined) {
        const probe = await getRun(config, runId, signal).catch(() => undefined)
        if (probe?.outcome) return { ...probe.outcome, replaceContent: lost }
        if (probe) {
          polling = true
          lost = true
          continue
        }
      }
      if (!retryable(error)) throw error
      errored = true
      if (document.visibilityState === "visible" && navigator.onLine) {
        if (++failures >= MAX_VISIBLE_FAILURES) throw error
      }
    }
    const backoff = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
    await waitToRetry(polling && !errored ? POLL_MS : backoff, signal)
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
  }
}

/** Settles a finished, stopped or failed reply: closes running tools, adds stats, saves it. */
async function finishTurn(turn: Turn, usage: TurnUsage | undefined) {
  const { draft, conversationId } = turn
  const endedAt = Date.now()
  draft.tools = draft.tools.map((t) =>
    t.status === "running" ? { ...t, status: "completed", endedAt } : t,
  )
  if (draft.approval && !draft.approval.resolved) {
    draft.approval = { ...draft.approval, resolved: "expired" }
  }
  if (draft.clarify && !draft.clarify.resolved) {
    draft.clarify = { ...draft.clarify, resolved: "expired" }
  }
  if (draft.status !== "error") draft.statusText = undefined
  if (draft.content || usage) {
    // Hermes's counts when it sent them; a stopped turn never gets them, so estimate.
    const tokens = usage?.completionTokens || estimateTokens(draft.content)
    const toolsUsed = draft.tools.length > 0
    // Nothing streamed when the run's events never arrived and only its final output did.
    const streamed = turn.firstTokenAt !== null
    const writingMs = Math.max(1, endedAt - (turn.firstTokenAt ?? endedAt))
    const stats: MessageStats = {
      tokens,
      estimated: !usage?.completionTokens,
      tokensPerSecond:
        toolsUsed || turn.resumed || !streamed
          ? undefined
          : Math.round(tokens / (writingMs / 1000)),
      durationMs: endedAt - draft.createdAt,
      promptTokens: usage?.promptTokens || undefined,
      toolsUsed,
    }
    draft.stats = stats
  }
  draft.runId = undefined
  draft.runSeq = undefined
  await turn.close()
  await updateConversation(conversationId, { updatedAt: endedAt })
  void refreshContext(conversationId)
  void refreshTodos(conversationId)
  const conversation = await db.conversations.get(conversationId)
  if (conversation?.projectId) {
    if (draft.status === "done" && conversation.mode === "plan")
      await db.conversations.update(conversationId, { planPending: true })
    // A moment later: the plugin's own hook records the finished plan-mode turn.
    setTimeout(() => {
      void refreshWorkspace(conversationId)
      void refreshPrs(conversationId, { force: true })
    }, PLUGIN_SETTLE_MS)
  }
}

/** Runs a turn on `/v1/runs` when Hermes has it, else streams a chat completion. */
async function runTurn(turn: Turn, start: () => Promise<{ usage?: TurnUsage }>) {
  const { draft, controller } = turn
  let usage: TurnUsage | undefined
  try {
    usage = (await start()).usage
    if (draft.status === "streaming") draft.status = "done"
  } catch (error) {
    if (controller.signal.aborted) {
      draft.status = "stopped"
    } else if (draft.runId && retryable(error)) {
      // Hermes may still be running it: leave the reply streaming for `reattachRun` to pick up.
      draft.statusText = undefined
      await turn.close()
      return draft.status
    } else {
      draft.status = "error"
      draft.statusText =
        error instanceof HermesError ? error.message : "Something went wrong talking to Hermes."
    }
  }
  await finishTurn(turn, usage)
  return draft.status
}

/**
 * Tool cards and the approval sit at offsets into the text streamed so far. When the run's final
 * text replaces it they are carried over proportionally and moved to the nearest paragraph break,
 * so a card never lands inside a word.
 */
function anchorOffsets(draft: Draft, next: string) {
  const previous = draft.content.length
  if (draft.content === next) return
  const breaks = [0, next.length]
  for (let at = next.indexOf("\n\n"); at >= 0; at = next.indexOf("\n\n", at + 2))
    breaks.push(at + 2)
  const anchor = (offset: number | undefined) => {
    if (offset === undefined) return undefined
    const target = previous ? Math.round((offset / previous) * next.length) : 0
    return breaks.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
  }
  draft.tools = draft.tools.map((t) => ({ ...t, contentOffset: anchor(t.contentOffset) }))
  if (draft.approval)
    draft.approval = { ...draft.approval, contentOffset: anchor(draft.approval.contentOffset) }
}

/** Folds a run's outcome into the reply; a run whose events were lost takes its final text. */
function settleRun(draft: Draft, outcome: RunOutcome) {
  if (outcome.output && (outcome.replaceContent || !draft.content)) {
    anchorOffsets(draft, outcome.output)
    draft.content = outcome.output
  }
  if (outcome.status === "cancelled") draft.status = "stopped"
  else if (outcome.status !== "completed") {
    draft.status = "error"
    draft.statusText = outcome.error || "Hermes couldn't finish this reply."
  }
  return { usage: outcome.usage }
}

async function followTurnRun(turn: Turn, runId: string) {
  return settleRun(turn.draft, await trackRun(turn, runId))
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

  const config = { baseUrl: profile.baseUrl, apiKey: profile.apiKey }
  const turn = openTurn(conversationId, config, reply)
  const options = {
    model: profile.model,
    messages: transcript,
    sessionId: conversation.hermesSessionId,
  }
  const status = await runTurn(turn, async () => {
    // A project session works in its worktree; the plugin can't be told about it any other way.
    const workspace = await ensureSessionWorkspace(conversationId, content)
    if (!(await supportsRuns(config))) {
      return streamChat(
        config,
        { ...options, signal: turn.controller.signal },
        streamHandlers(turn),
      )
    }
    const runId = await startRun(config, {
      ...options,
      idempotencyKey: reply.id,
      workspaceInstructions: workspace?.instructions,
    })
    turn.draft.runId = runId
    turn.touch()
    if (turn.controller.signal.aborted) {
      void stopRun(config, runId).catch(() => undefined)
      throw new DOMException("Aborted", "AbortError")
    }
    return followTurnRun(turn, runId)
  })

  if (status !== "done") return
  // Hermes only keys the session by our id when the profile has an API key.
  const turnNumber = history.filter((m) => m.role === "user" && m.status === "done").length + 1
  if (config.apiKey && turnNumber <= TITLED_TURNS) {
    void syncTitle(conversationId, config, conversation.hermesSessionId)
    void labelSession(config, conversation.hermesSessionId)
  }
  // A stop or an error pauses the queue: the user probably wants to look before it carries on.
  await sendNextQueued(conversationId)
}

/**
 * Follows the run Hermes is still working on for a chat that was reopened. A reply left streaming
 * by a connection that gave up, or by a reload before its run id was saved, is the one to pick up.
 */
export async function reattachRun(conversationId: string) {
  if (controllers.has(conversationId)) return
  const conversation = await db.conversations.get(conversationId)
  const profile = await profileFor(conversation?.profileId)
  if (!conversation || !profile) return
  const stale = (await getMessages(conversationId)).findLast(
    (m) => m.role === "assistant" && m.status === "streaming",
  )
  if (!stale) return
  // Hermes only keys the session by our id with an API key, so only then can the run be looked up.
  const live = profile.apiKey
    ? await liveRunOf(
        { baseUrl: profile.baseUrl, apiKey: profile.apiKey },
        conversation.hermesSessionId,
      ).catch(() => undefined)
    : undefined
  const runId = stale.runId ?? live?.runId
  if (!runId) {
    // Nothing is running for it: a streamed chat completion died with the tab, or the run never
    // started.
    await db.messages.update(stale.id, { status: "stopped", statusText: undefined })
    return
  }
  if (!stale.runId) await db.messages.update(stale.id, { runId })
  await resumeReply({ ...stale, runId })
}

/** Picks up a reply whose run was still going when the app was closed or reloaded. */
async function resumeReply(reply: Message) {
  const { conversationId, runId } = reply
  if (!runId || controllers.has(conversationId)) return
  const conversation = await db.conversations.get(conversationId)
  const profile = await profileFor(conversation?.profileId)
  if (!conversation || !profile) {
    await db.messages.update(reply.id, { status: "stopped", statusText: undefined })
    return
  }
  const config = { baseUrl: profile.baseUrl, apiKey: profile.apiKey }
  const turn = openTurn(conversationId, config, reply, true)
  const status = await runTurn(turn, () => followTurnRun(turn, runId))
  if (status === "done") await sendNextQueued(conversationId)
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
  const turn = turns.get(conversationId)
  const runId = turn?.draft.runId
  if (turn && runId) void stopRun(turn.config, runId).catch(() => undefined)
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

/** Sends the user's answers to the agent's questions; a question left blank is skipped. */
export async function answerClarify(
  message: Message,
  answers: ClarifyAnswers,
  outcome: "submitted" | "cancelled" = "submitted",
) {
  const clarify = message.clarify
  if (!clarify) return
  const conversation = await db.conversations.get(message.conversationId)
  const profile = await profileFor(conversation?.profileId)
  if (!profile) return
  await respondToClarify({ baseUrl: profile.baseUrl, apiKey: profile.apiKey }, clarify.runId, {
    clarifyId: clarify.clarifyId,
    answers,
    outcome,
  })
  const active = activeDrafts.get(message.id)
  if (active?.draft.clarify) {
    Object.assign(active.draft, settledClarify(active.draft, answers, outcome))
    active.touch()
  } else {
    await db.messages.update(message.id, settledClarify(message, answers, outcome))
  }
}

/**
 * Replies left "streaming" by a closed tab: one on a Hermes run picks up where it left off, since
 * the run carried on without us. A streamed chat completion died with the tab, so it's stopped.
 */
export async function recoverInterruptedMessages() {
  const interrupted = await db.messages.filter((m) => m.status === "streaming").toArray()
  await Promise.all(
    interrupted.map((reply) =>
      reply.runId ? resumeReply(reply) : reattachRun(reply.conversationId),
    ),
  )
}
