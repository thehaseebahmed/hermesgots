import { toast } from "sonner"

import { serverConfig } from "@/lib/connection"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  db,
  getActiveProfile,
  getMessages,
  type ApprovalChoice,
  type Attachment,
  type ClarifyAnswers,
  type ClarifyRequest,
  type Conversation,
  type Message,
  type MessageStats,
  type MessageStatus,
  type Profile,
  type ToolEvent,
  updateConversation,
} from "@/lib/db"
import {
  addToQueue,
  clarifyQuestions,
  followRun,
  getRun,
  getQueue,
  getSessionTitle,
  hasPluginFeature,
  HermesError,
  labelSession,
  queueAction,
  respondToApproval,
  respondToClarify,
  runRequest,
  startRun,
  steerRun,
  stopRun,
  streamChat,
  supportsRuns,
  uploadAttachment,
  type ApprovalRequestEvent,
  type ChatMessage,
  type HermesConfig,
  type QueueItem,
  type RunOutcome,
  type StreamHandlers,
  type TurnUsage,
} from "@/lib/hermes"
import { attachmentsText, setUploading, wireContent } from "@/lib/attachments"
import { refreshContext } from "@/lib/context"
import { refreshChatProviderUsage } from "@/lib/provider-usage"
import { liveTurn, noteFollowUps, patchStats, reconcileHistory } from "@/lib/history"
import { isLive } from "@/lib/live"
import { onTodoTool, refreshTodos } from "@/lib/todos"
import { quietly } from "@/lib/report"
import { randomId } from "@/lib/utils"
import { knownLiveRun, readLiveRuns } from "@/lib/waiting"
import { onWake } from "@/lib/wake"
import {
  ensureSessionWorkspace,
  refreshLibrary,
  refreshPrs,
  refreshWorkspace,
} from "@/lib/workspace"

/**
 * Sends a turn to Hermes and persists the streamed reply into IndexedDB as it arrives.
 * The UI renders straight from Dexie live queries, so it never holds stream state itself.
 */

/**
 * How often streamed text is written to IndexedDB. Each write re-runs every live query over the
 * chat, and `useReveal` paces the text on screen anyway, so a faster write buys nothing. A tool
 * call, an approval, a question or a status change is written at once.
 */
const FLUSH_INTERVAL_MS = 150
/**
 * How long one status or transcript read of a running turn may take. A connection can die without
 * the request ever failing (a phone that slept, a tunnel that dropped it), which would hold the
 * reply on its last tool call for good.
 */
/** How often a run whose events can't be read is polled, with the transcript. */
const POLL_MS = 3000
/**
 * How often the run's status is read while its events stream is open. The stream keeps its own
 * connection alive with keepalives, so a stream whose events stopped arriving (a quiet fan-out, a
 * proxy holding it open) never times out — only a terminal status read here ends the turn.
 */
const STREAM_POLL_MS = 10_000
/** How long after a turn ends before the plugin is asked about it. */
const PLUGIN_SETTLE_MS = 1500
/** Hermes upgrades a placeholder title on later turns, up to the third. */
const TITLED_TURNS = 3
/** Hermes titles with a model call in the background, which can land after the reply ends. */
const TITLE_CHECKS_MS = [0, 3000, 10000]
/** A reply whose connection gave up is followed again after these waits, the last one repeating. */
const REATTACH_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
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
    if (delay) {
      // A server that streams its changes says when the title lands.
      if (isLive(config)) return
      await new Promise((resolve) => window.setTimeout(resolve, delay))
    }
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

/** What about a reply is worth writing at once, rather than with the next batch of text. */
function shape(draft: Draft) {
  const done = draft.tools.filter((t) => t.status !== "running").length
  const { approval, clarify } = draft
  return [
    draft.status,
    draft.statusText,
    draft.tools.length,
    done,
    approval?.command,
    approval?.resolved,
    clarify?.clarifyId,
    Boolean(clarify?.resolved),
  ].join("|")
}

/** Mutable working copy of a reply, flushed to Dexie on a timer so token deltas don't hammer IndexedDB. */
function openTurn(
  conversationId: string,
  config: HermesConfig,
  reply: Message,
  resumed = false,
  existingController?: AbortController,
): Turn {
  const draft: Draft = { ...reply, tools: [...(reply.tools ?? [])] }
  let dirty = false
  let closed = false
  let timer: number | undefined
  // One write at a time: a slow IndexedDB queues no backlog, and the next write takes the latest.
  let writing: Promise<void> = Promise.resolve()
  let flushed = shape(draft)
  const flush = () => {
    timer = undefined
    writing = writing.then(async () => {
      if (!dirty) return
      dirty = false
      flushed = shape(draft)
      const { id: _id, ...changes } = draft
      await db.messages.update(reply.id, changes)
    })
    return writing
  }
  const touch = () => {
    dirty = true
    if (closed) return
    const urgent = shape(draft) !== flushed
    if (urgent) window.clearTimeout(timer)
    if (urgent || timer === undefined)
      timer = window.setTimeout(flush, urgent ? 0 : FLUSH_INTERVAL_MS)
  }
  const controller = existingController ?? new AbortController()
  const close = async () => {
    closed = true
    window.clearTimeout(timer)
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
  outcome: "submitted" | "cancelled" | "timed_out" | "undelivered",
) {
  const clarify = { ...message.clarify!, resolved: { answers, outcome } }
  const tools = [...(message.tools ?? [])]
  const at = tools.findLastIndex((t) => t.tool === "clarify")
  if (at >= 0) tools[at] = { ...tools[at], result: clarifyResult(clarify, answers, outcome) }
  return { clarify, tools }
}

const APPROVAL_CHOICES: ApprovalChoice[] = ["once", "session", "always", "deny"]

/** Hermes's error codes for an approval answered too late: nothing waits on it any more. */
const APPROVAL_GONE = new Set(["approval_not_pending", "approval_not_active", "run_not_found"])

function raiseApproval(turn: Turn, event: ApprovalRequestEvent) {
  const { draft, touch } = turn
  draft.approval = {
    runId: event.run_id,
    askedAt: typeof event.timestamp === "number" ? event.timestamp : undefined,
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
        // Only a patch whose whole result fit in the preview can be counted here.
        if (existing.tool === "patch" && event.status === "completed" && event.result)
          Object.assign(existing, patchStats(event.result))
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
      // Preserve the actual outcome: timed_out and undelivered are not submitted.
      const KNOWN = ["submitted", "cancelled", "timed_out", "undelivered"] as const
      type Outcome = (typeof KNOWN)[number]
      const outcome: Outcome = KNOWN.includes(event.outcome as Outcome)
        ? (event.outcome as Outcome)
        : "submitted"
      Object.assign(draft, settledClarify(draft, event.answers ?? {}, outcome))
      touch()
    },
    // Answered on another device, or it stopped waiting (timed out, withdrawn) with no answer.
    onApprovalResolved(event) {
      const shown = draft.approval
      if (!shown || shown.runId !== event.run_id) return
      if (shown.resolved && shown.resolved !== "expired") return
      const choice = APPROVAL_CHOICES.find((c) => c === event.choice) ?? "expired"
      if (shown.resolved === choice) return
      draft.approval = { ...shown, resolved: choice }
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
  return async (signal: AbortSignal) => {
    const reply = await liveTurn(config, conversation.hermesSessionId, user.content, signal).catch(
      () => undefined,
    )
    if (!reply) return
    const done = new Set(
      draft.tools.filter((t) => t.status === "completed").map((t) => t.toolCallId),
    )
    // Not through onTool: these carry Hermes's own call ids, which history matches later.
    draft.tools = (reply.tools ?? []).map((tool) => {
      if (tool.tool !== "clarify" || tool.result) return tool
      const settled = draft.tools.find((t) => t.toolCallId === tool.toolCallId)
      // The answer can arrive here before Hermes persists the tool's result row.
      return settled?.result ? { ...tool, result: settled.result } : tool
    })
    // The transcript holds a todo call's whole result, so its list shows while the turn runs.
    for (const tool of draft.tools)
      if (tool.status === "completed" && !done.has(tool.toolCallId))
        void onTodoTool(conversationId, tool.tool, tool.result)
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
  let readTranscript: ((signal: AbortSignal) => Promise<void>) | undefined
  let failures = 0
  let errored = false
  // Raises an approval or question the run's status says it waits on, and expires one it no longer
  // does. The events stream carries both too, so an approval already on the reply isn't raised
  // again, and neither is one answered while the read was out: Hermes saw it still waiting.
  const applyStatus = async (signal: AbortSignal) => {
    const before = draft.approval
    const { outcome, approval, clarify } = await getRun(config, runId, signal)
    if (outcome) return { ...outcome, replaceContent: lost } as RunOutcome
    if (approval) {
      const shown = draft.approval
      // Hermes leaves a request that timed out on the status until the run moves on, so one
      // already settled here is never raised again; only a new request is.
      const exact = shown?.askedAt !== undefined && typeof approval.timestamp === "number"
      if (exact) {
        if (shown.askedAt !== approval.timestamp) raiseApproval(turn, approval)
      } else {
        const same =
          shown?.command === approval.command && shown?.description === approval.description
        if (!same || (shown?.resolved && shown === before)) raiseApproval(turn, approval)
      }
    } else if (
      draft.approval &&
      !draft.approval.resolved &&
      (polling || draft.approval === before)
    ) {
      // Hermes parks the status before it sends the request, so a status read after the card
      // went up that no longer waits means the approval went without this device.
      draft.approval = { ...draft.approval, resolved: "expired" }
      touch()
    }
    // A client that can only poll still gets the question: the plugin keeps it on the status.
    if (clarify) handlers.onClarify?.(clarify)
    else if (polling && draft.clarify && !draft.clarify.resolved) {
      draft.clarify = { ...draft.clarify, resolved: "expired" }
      touch()
    }
    return undefined
  }
  // When the stream last carried an event; its keepalives don't count.
  let heardAt = Date.now()
  const heard = new Proxy(handlers, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        heardAt = Date.now()
        return value.apply(target, args)
      }
    },
  })
  // Reads the run's status now and then while its events stream is open: a stalled stream still
  // keepalives, so only this sees the run finish (or wait on the user) and ends the turn.
  const watchStatus = (current: AbortSignal, done: (outcome: RunOutcome) => void) => {
    const watcher = new AbortController()
    const timer = window.setInterval(() => {
      if (watcher.signal.aborted || current.aborted || signal.aborted) return
      // Events still arriving say the run goes on; only a quiet stream needs its status read.
      if (Date.now() - heardAt < STREAM_POLL_MS) return
      void applyStatus(AbortSignal.any([current, AbortSignal.timeout(READ_TIMEOUT_MS)])).then(
        (outcome) => {
          if (outcome) {
            watcher.abort()
            done(outcome)
          }
        },
        () => undefined,
      )
    }, STREAM_POLL_MS)
    const stop = () => {
      watcher.abort()
      window.clearInterval(timer)
      current.removeEventListener("abort", stop)
      signal.removeEventListener("abort", stop)
    }
    current.addEventListener("abort", stop)
    signal.addEventListener("abort", stop)
    return stop
  }
  for (let attempt = 0; ; attempt++) {
    // Coming back to the app drops this attempt's connection, which may have died meanwhile, and
    // reads the run again at once rather than once a timeout notices.
    const woken = new AbortController()
    const stopWaking = onWake(() => woken.abort(new DOMException("Woken", "AbortError")))
    const current = AbortSignal.any([signal, woken.signal])
    const timed = () => AbortSignal.any([current, AbortSignal.timeout(READ_TIMEOUT_MS)])
    try {
      if (!polling) {
        const lastSeq = draft.runSeq ?? -1
        let streamError: unknown
        let settled: RunOutcome | undefined
        const outcome = await new Promise<RunOutcome | null>((resolve) => {
          const stopWatching = watchStatus(current, (settledRun) => {
            settled = settledRun
            // Drop the stream's connection: the run it followed is over.
            woken.abort(new DOMException("Settled", "AbortError"))
            resolve(settledRun)
          })
          void followRun(config, runId, { lastSeq, signal: current }, heard).then(
            (streamed) => {
              stopWatching()
              resolve(streamed)
            },
            (error) => {
              stopWatching()
              streamError = error
              resolve(null)
            },
          )
        })
        // The status watcher saw the run finish before the stream's own error arrived.
        if (settled) return settled
        // The stream's error keeps its own handling below (404 -> polling); only a stream that
        // ended quietly falls through to the status read.
        if (streamError) throw streamError
        if (outcome) return outcome
      } else {
        readTranscript ??= await transcriptReader(turn)
        await readTranscript?.(timed())
      }
      const status = await applyStatus(timed())
      if (status) return status
      failures = 0
      errored = false
    } catch (error) {
      if (signal.aborted) throw error
      if (woken.signal.aborted) continue
      if (error instanceof HermesError && error.status === 404) {
        if (polling) return { status: "interrupted", error: "Hermes no longer has this reply." }
        polling = true
        lost = true
        continue
      }
      // No response to the events request while the run itself answers: the browser blocks the
      // stream (Hermes v2026.9.24 sends it without CORS headers), so retrying it never helps.
      if (!polling && error instanceof HermesError && error.status === undefined) {
        const probe = await getRun(config, runId, timed()).catch(() => undefined)
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
    } finally {
      stopWaking()
    }
    const backoff = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
    await waitToRetry(polling && !errored ? POLL_MS : backoff, signal)
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
  }
}

/**
 * Settles a finished, stopped or failed reply: closes running tools, adds stats, saves it. A send
 * that never reached Hermes leaves nothing on the host to read again, so its follow-ups — context,
 * provider limits, todos, a session's workspace and pull requests — are left alone.
 */
async function finishTurn(turn: Turn, usage: TurnUsage | undefined, sendFailed = false) {
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
  if (!sendFailed) {
    noteFollowUps(conversationId)
    void refreshContext(conversationId)
    void refreshChatProviderUsage(conversationId).catch(quietly("Reading provider limits"))
    void refreshTodos(conversationId)
  }
  await updateConversation(conversationId, { updatedAt: endedAt })
  const conversation = await db.conversations.get(conversationId)
  if (conversation?.projectId && !sendFailed) {
    if (draft.status === "done" && conversation.mode === "plan")
      await db.conversations.update(conversationId, { planPending: true })
    // A moment later: the plugin's own hook records the finished plan-mode turn.
    setTimeout(() => {
      void refreshWorkspace(conversationId)
      void refreshPrs(conversationId, { force: true })
      void refreshLibrary(conversationId)
    }, PLUGIN_SETTLE_MS)
  }
}

/**
 * Takes the steers Hermes handed back unread off the reply: `pending` is their text joined by
 * newlines, the newest last.
 */
function dropUnread(draft: Draft, pending: string) {
  const steers = draft.steers ?? []
  for (let from = 0; from < steers.length; from++) {
    const tail = steers.slice(from)
    if (tail.map((steer) => steer.text).join("\n") === pending.trim()) {
      draft.steers = steers.slice(0, from)
      return
    }
  }
}

/** Puts a steer the agent never read at the front of the queue, to go as the next turn. */
async function requeueSteer(conversationId: string, text: string) {
  const queued = (await getMessages(conversationId)).find((m) => m.status === "queued")
  await db.messages.add({
    id: randomId(),
    conversationId,
    role: "user",
    content: text.trim(),
    status: "queued",
    createdAt: queued ? queued.createdAt - 1 : Date.now(),
  })
}

const reattachTries = new Map<string, number>()
function reattachLater(conversationId: string) {
  const tries = reattachTries.get(conversationId) ?? 0
  reattachTries.set(conversationId, tries + 1)
  window.setTimeout(
    () => reattachRun(conversationId).catch(quietly("Reattaching a run")),
    REATTACH_MS[Math.min(tries, REATTACH_MS.length - 1)],
  )
}

/** Runs a turn on `/v1/runs` when Hermes has it, else streams a chat completion. */
async function runTurn(
  turn: Turn,
  start: () => Promise<{ usage?: TurnUsage; pendingSteer?: string }>,
): Promise<{ status: MessageStatus; sendFailed: boolean }> {
  const { draft, controller } = turn
  let usage: TurnUsage | undefined
  let pendingSteer: string | undefined
  // The turn failed before anything reached Hermes, so the message can be sent again.
  let sendFailed = false
  try {
    const result = await start()
    usage = result.usage
    pendingSteer = result.pendingSteer
    if (pendingSteer) dropUnread(draft, pendingSteer)
    if (draft.status === "streaming") draft.status = "done"
  } catch (error) {
    if (controller.signal.aborted) {
      draft.status = "stopped"
    } else if (draft.runId && retryable(error)) {
      // Hermes may still be running it: leave the reply streaming and follow it again soon. Until
      // then it holds the chat's catch-up and queue, so the chat's own timer is too slow for it.
      draft.statusText = undefined
      await turn.close()
      reattachLater(turn.conversationId)
      return { status: draft.status, sendFailed }
    } else {
      draft.status = "error"
      draft.statusText =
        error instanceof HermesError ? error.message : "Something went wrong talking to Hermes."
      // A run that never started and nothing streamed: the message didn't reach Hermes at all, so it
      // can go again. A reply that failed part-way through has something to keep, and its turn did
      // reach the host.
      if (!draft.runId && !draft.content && !draft.tools.length) sendFailed = true
    }
  }
  reattachTries.delete(turn.conversationId)
  await finishTurn(turn, usage, sendFailed)
  // The plugin puts a leftover steer first in its own queue, and starts what waits there.
  if (await hostQueue(turn.config)) followHostQueue(turn.conversationId)
  else if (pendingSteer) await requeueSteer(turn.conversationId, pendingSteer)
  return { status: draft.status, sendFailed }
}

/**
 * Tool cards, the approval and steers sit at offsets into the text streamed so far. When the text is
 * rewritten they carry over exactly: an offset in the common prefix keeps its place, one in the
 * common suffix moves by the suffix's shift, and one inside a rewritten region parks at the
 * rewrite's start, in call order — the call ran around there, and any finer place would be invented.
 */
function anchorOffsets(draft: Draft, next: string) {
  const previous = draft.content
  if (previous === next) return
  const cap = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < cap && previous[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < cap - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix += 1
  const movedEnd = previous.length - suffix
  const shift = next.length - previous.length
  const anchor = (offset: number) =>
    offset <= prefix ? offset : offset >= movedEnd ? offset + shift : prefix
  draft.tools = draft.tools.map((t) =>
    t.contentOffset === undefined ? t : { ...t, contentOffset: anchor(t.contentOffset) },
  )
  if (draft.approval && draft.approval.contentOffset !== undefined)
    draft.approval = { ...draft.approval, contentOffset: anchor(draft.approval.contentOffset) }
  if (draft.steers)
    draft.steers = draft.steers.map((s) => ({ ...s, contentOffset: anchor(s.contentOffset) }))
}

/** Where the text streamed since the last tool call starts; the run's final answer replaces it. */
function finalTextStart(draft: Draft) {
  return Math.max(0, ...draft.tools.map((t) => t.contentOffset ?? 0))
}

/**
 * Puts the run's final answer in place of the text streamed since the last tool call. They differ
 * when Hermes asked the model to go on after a cut-off or a fragment (a `[System: …]` note the
 * stream never shows): what streamed holds every attempt, the output only the answer.
 */
function settleFinalText(draft: Draft, output: string) {
  const streamed = draft.content.slice(finalTextStart(draft))
  if (!streamed.trim() || streamed.trim() === output.trim()) return
  const next =
    draft.content.slice(0, finalTextStart(draft)) + /^\s*/.exec(streamed)![0] + output.trim()
  anchorOffsets(draft, next)
  draft.content = next
}

/** Folds a run's outcome into the reply; a run whose events were lost takes its final text. */
function settleRun(draft: Draft, outcome: RunOutcome) {
  if (outcome.output && (outcome.replaceContent || !draft.content)) {
    // The events were lost and only the transcript filled the reply. When the answer is already the
    // rendered tail, the text and its offsets say where the calls ran and stay; a real rewrite
    // carries the offsets over exactly.
    const tail = draft.content.slice(finalTextStart(draft))
    const kept =
      !!tail.trim() &&
      (tail.trim() === outcome.output.trim() ||
        draft.content.trimEnd().endsWith(outcome.output.trim()))
    if (!draft.content) draft.content = outcome.output
    else if (!kept) {
      anchorOffsets(draft, outcome.output)
      draft.content = outcome.output
    }
  } else if (outcome.output && outcome.status === "completed") {
    settleFinalText(draft, outcome.output)
  }
  if (outcome.status === "cancelled") draft.status = "stopped"
  else if (outcome.status !== "completed") {
    draft.status = "error"
    draft.statusText = outcome.error || "Hermes couldn't finish this reply."
  }
  return { usage: outcome.usage, pendingSteer: outcome.pendingSteer }
}

async function followTurnRun(turn: Turn, runId: string) {
  return settleRun(turn.draft, await trackRun(turn, runId))
}

/** A turn that never started because an attachment couldn't be saved on the host. */
export class AttachmentError extends HermesError {}

const UPLOADS_AT_ONCE = 3

/**
 * Saves each attachment on the Hermes host through the plugin, a few at a time, so the agent can
 * open it on later turns too. An image still goes inline when that fails; a file has no other way
 * to get there.
 */
async function uploadAttachments(
  config: HermesConfig,
  sessionId: string,
  attachments: Attachment[],
  plugin: boolean,
) {
  const saved = [...attachments]
  const pending = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => !attachment.path && attachment.blob)
    .filter(({ attachment }) => plugin || !attachment.image)
  const missing = pending.find(({ attachment }) => !plugin && !attachment.image)
  if (missing)
    throw new AttachmentError(`Attaching ${missing.attachment.name} needs the Gots plugin.`)
  for (const { attachment } of pending) setUploading(attachment.id, true)
  try {
    const upload = async ({ attachment, index }: (typeof pending)[number]) => {
      try {
        const path = await uploadAttachment(config, sessionId, {
          name: attachment.name,
          blob: attachment.blob!,
        })
        saved[index] = { ...attachment, path }
      } catch (error) {
        if (!attachment.image) {
          const reason = error instanceof Error ? error.message : ""
          throw new AttachmentError(
            reason.includes(attachment.name)
              ? reason
              : `Couldn't attach ${attachment.name}${reason ? `: ${reason.replace(/\.$/, "")}` : ""}.`,
          )
        }
      } finally {
        setUploading(attachment.id, false)
      }
    }
    const queue = [...pending]
    await Promise.all(
      Array.from({ length: Math.min(UPLOADS_AT_ONCE, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await upload(next)
      }),
    )
  } finally {
    for (const { attachment } of pending) setUploading(attachment.id, false)
  }
  return saved
}

/** The chat's own pick, else the bot's default, else whatever the host runs. */
function modelOf(conversation: Conversation, profile: Profile) {
  const chosen = conversation.modelChoice ?? profile.modelChoice
  return { model: chosen?.model ?? profile.model, provider: chosen?.provider }
}

/**
 * When a new turn starts: now, or just after the chat's last message when the host's clock, which
 * stamped the turns loaded from it, runs ahead of this device's. Queued messages wait after it.
 */
function nextAt(messages: Message[]) {
  return messages.reduce(
    (at, m) => (m.status === "queued" ? at : Math.max(at, m.createdAt + 1)),
    Date.now(),
  )
}

/** Writes the user's message and the empty reply, before the turn opens. */
async function prepareSend(
  conversationId: string,
  queuedId: string | undefined,
  content: string,
  attachments: Attachment[],
) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return undefined
  const profile = await profileFor(conversation.profileId)
  if (!profile) return undefined
  const history = await getMessages(conversationId)
  const now = nextAt(history)
  const userMessage: Message = {
    id: queuedId ?? randomId(),
    conversationId,
    role: "user",
    content,
    ...(attachments.length ? { attachments } : {}),
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
      ...(history.length === 0 && !conversation.titleEdited
        ? { title: titleFrom(content || attachments[0].name) }
        : {}),
    })
  })
  return { conversation, profile, history, userMessage, reply }
}

/** Stop pressed while a turn sets up: nothing has started on Hermes yet, so nothing needs stopping. */
function stopIfAborted(turn: Turn) {
  if (turn.controller.signal.aborted) throw new DOMException("Aborted", "AbortError")
}

/** `queuedId` sends a queued message, keeping its id so the bubble doesn't remount. */
export async function sendMessage(
  conversationId: string,
  text: string,
  options: { queuedId?: string; attachments?: Attachment[] } = {},
) {
  const { queuedId } = options
  const content = text.trim()
  const attachments = options.attachments ?? []
  if ((!content && !attachments.length) || controllers.has(conversationId)) return
  // Acquire the guard before any await: two concurrent calls for the same chat both
  // passed it once and each started a run, duplicating the turn.
  const controller = new AbortController()
  controllers.set(conversationId, controller)
  // Until the turn opens and owns the guard, a throw (say IndexedDB's quota) must release it, or
  // the chat can't send again until a reload.
  const prepared = await prepareSend(conversationId, queuedId, content, attachments).catch(
    (error: unknown) => {
      controllers.delete(conversationId)
      throw error
    },
  )
  if (!prepared) {
    controllers.delete(conversationId)
    return
  }
  const { conversation, profile, history, userMessage, reply } = prepared

  const transcript: ChatMessage[] = history
    .filter((m) => m.status === "done" || (m.role === "assistant" && m.content))
    .map((m) => ({ role: m.role, content: attachmentsText(m.content, m.attachments) }))

  const config = serverConfig(profile)
  const turn = openTurn(conversationId, config, reply, false, controller)
  const { status, sendFailed } = await runTurn(turn, async () => {
    // Without a key Hermes keeps no session under our id, so nothing would sync or resume.
    if (!config.apiKey) throw new HermesError("This bot has no API key. Link it in Settings.")
    // A project session works in its worktree; the plugin can't be told about it any other way.
    const workspace = await ensureSessionWorkspace(conversationId, content || attachments[0].name)
    stopIfAborted(turn)
    let sent = attachments
    if (attachments.length) {
      sent = await uploadAttachments(
        config,
        conversation.hermesSessionId,
        attachments,
        Boolean(profile.apiKey),
      )
      await db.messages.update(userMessage.id, { attachments: sent })
      stopIfAborted(turn)
    }
    const turnOptions = {
      ...modelOf(conversation, profile),
      sessionId: conversation.hermesSessionId,
      messages: [
        ...transcript,
        { role: "user" as const, content: await wireContent(content, sent) },
      ],
    }
    if (!(await supportsRuns(config))) {
      return streamChat(
        config,
        { ...turnOptions, signal: turn.controller.signal },
        streamHandlers(turn),
      )
    }
    const runId = await startRun(config, {
      ...turnOptions,
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

  if (sendFailed) {
    // Nothing reached Hermes, so the message keeps its place, its text and its attachments, and
    // waits to be sent again or dropped. The empty reply row that recorded the failure goes, and the
    // reason is kept on the message.
    await db.transaction("rw", db.messages, async () => {
      await db.messages.delete(reply.id)
      await db.messages.update(userMessage.id, {
        status: "error",
        statusText: turn.draft.statusText,
      })
    })
  }
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
  if (!stale) return adoptRun(conversation, profile)
  // Hermes only keys the session by our id with an API key, so only then can the run be looked up,
  // and only the plugin lists runs.
  // Read through the shared poll, so the sidebar and the project screen hear the same answer.
  const live =
    profile.apiKey && !profile.disabled ? await readLiveRuns(serverConfig(profile)) : undefined
  const runId = stale.runId ?? live?.runIds[conversation.hermesSessionId]
  if (!runId) {
    // Nothing is running for it: a streamed chat completion died with the tab, or the run never
    // started.
    await db.messages.update(stale.id, { status: "stopped", statusText: undefined })
    return
  }
  if (!stale.runId) await db.messages.update(stale.id, { runId })
  await resumeReply({ ...stale, runId })
}

// How far apart the host's and the transcript's clocks may read for one turn.
const RUN_START_SLACK_S = 5

/**
 * Follows a run this device didn't start (another device's, the plugin's queue), once the host's
 * shared `runs/live` answer names it for this chat, so the session screen shows what its project
 * does. The turn has to be in the transcript with a reply row already, so the live reply is the
 * one the transcript will hold when the run ends; a turn the host hasn't written yet waits for the
 * next catch-up.
 */
async function adoptRun(conversation: Conversation, profile: Profile) {
  if (!profile.apiKey || profile.disabled) return
  const server = serverConfig(profile)
  const sessionId = conversation.hermesSessionId
  if (!knownLiveRun(server, sessionId)) return
  const id = conversation.id
  await reconcileHistory(id)
  // Asked again after the catch-up: the run may have ended meanwhile, and a finished one of this
  // device's own is not to be followed twice.
  const live = knownLiveRun(server, sessionId)
  if (!live || controllers.has(id)) return
  const run = await getRun(server, live.runId, AbortSignal.timeout(READ_TIMEOUT_MS))
  if (!ACTIVE_RUN.has(run.status) || run.createdAt === undefined) return
  const messages = await getMessages(id)
  const at = messages.findLastIndex((m) => m.role === "user" && m.hermesRowId !== undefined)
  const reply = messages[at + 1]
  if (at < 0 || reply?.role !== "assistant" || reply.status === "streaming") return
  // The turn of this run, not an earlier one: the host wrote it after the run started.
  if (messages[at].createdAt / 1000 < run.createdAt - RUN_START_SLACK_S) return
  // The replay of the run's events builds the reply again from its start.
  const adopted: Message = {
    ...reply,
    content: "",
    tools: [],
    steers: undefined,
    reasoning: undefined,
    status: "streaming",
    runId: live.runId,
    runSeq: undefined,
  }
  await db.messages.put(adopted)
  await resumeReply(adopted)
}

/** Picks up a reply whose run was still going when the app was closed or reloaded. */
async function resumeReply(reply: Message) {
  const { conversationId, runId } = reply
  if (!runId || controllers.has(conversationId)) return
  const controller = new AbortController()
  controllers.set(conversationId, controller)
  const conversation = await db.conversations.get(conversationId)
  const profile = await profileFor(conversation?.profileId)
  if (!conversation || !profile) {
    controllers.delete(conversationId)
    await db.messages.update(reply.id, { status: "stopped", statusText: undefined })
    return
  }
  const config = serverConfig(profile)
  const turn = openTurn(conversationId, config, reply, true, controller)
  const { status } = await runTurn(turn, () => followTurnRun(turn, runId))
  if (status === "done") await sendNextQueued(conversationId)
}

/**
 * Whether queued messages wait on the Hermes host, where the Gots plugin starts each once the
 * run before it is over, with the app closed too. Without it they wait here.
 */
async function hostQueue(config: HermesConfig) {
  return (
    Boolean(config.apiKey) &&
    (await supportsRuns(config)) &&
    (await hasPluginFeature(config, "queue"))
  )
}

async function hostOf(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  const profile = await profileFor(conversation?.profileId)
  if (!conversation || !profile) return undefined
  const config = serverConfig(profile)
  return { conversation, profile, config }
}

/** Saves the attachments on the host and hands the plugin the turn it will start. */
async function queueOnHost(
  conversation: Conversation,
  profile: Profile,
  config: HermesConfig,
  content: string,
  attachments: Attachment[],
) {
  const sessionId = conversation.hermesSessionId
  const workspace = await ensureSessionWorkspace(conversation.id, content || attachments[0].name)
  const sent = attachments.length
    ? await uploadAttachments(config, sessionId, attachments, true)
    : attachments
  const run = runRequest(config, {
    ...modelOf(conversation, profile),
    sessionId,
    messages: [{ role: "user", content: await wireContent(content, sent) }],
    workspaceInstructions: workspace?.instructions,
  })
  const item = await addToQueue(config, sessionId, {
    text: content,
    attachments: sent.map(({ name, type, size, path }) => ({ name, type, size, path })),
    run,
  })
  return { item, sent }
}

/** Holds a message until the current reply finishes. */
export async function queueMessage(
  conversationId: string,
  text: string,
  attachments: Attachment[] = [],
) {
  const content = text.trim()
  if (!content && !attachments.length) return
  const message: Message = {
    id: randomId(),
    conversationId,
    role: "user",
    content,
    ...(attachments.length ? { attachments } : {}),
    status: "queued",
    createdAt: Date.now(),
  }
  const host = await hostOf(conversationId)
  if (host && (await hostQueue(host.config))) {
    try {
      const { item, sent } = await queueOnHost(
        host.conversation,
        host.profile,
        host.config,
        content,
        attachments,
      )
      await db.messages.add({
        ...message,
        id: item.id,
        ...(sent.length ? { attachments: sent } : {}),
        hostQueued: true,
      })
      // The run may have ended while it was being queued, and the plugin started it at once.
      followHostQueue(conversationId)
      return
    } catch {
      // It waits here instead, and goes from this device.
    }
  }
  await db.messages.add(message)
}

/** Hermes's transcript times are its own clock's, in whole seconds. */
const CLOCK_SLACK_MS = 5000

const ACTIVE_RUN = new Set(["queued", "running", "waiting_for_approval", "stopping"])

function attachmentsOf(item: QueueItem): Attachment[] | undefined {
  if (!item.attachments.length) return undefined
  return item.attachments.map((file, index) => ({
    id: `${item.id}-${index}`,
    name: file.name,
    type: file.type ?? "application/octet-stream",
    size: file.size ?? 0,
    image: Boolean(file.type?.startsWith("image/")),
    path: file.path,
  }))
}

/**
 * Brings the plugin's queue for a chat here: what still waits shows above the composer, and a turn
 * the plugin started is followed live like one sent from this device. One that already finished is
 * left to the transcript.
 */
async function syncQueue(conversationId: string) {
  const host = await hostOf(conversationId)
  if (!host || !(await hostQueue(host.config))) return
  const { items, sent, paused } = await getQueue(host.config, host.conversation.hermesSessionId)
  const local = await getMessages(conversationId)
  const byId = new Map(local.map((m) => [m.id, m]))
  const waiting = new Set(items.map((item) => item.id))
  const startedIds = new Set(sent.map((item) => item.id))
  let finished = false
  const follow: Message[] = []
  await db.transaction("rw", db.messages, async () => {
    for (const m of local) {
      if (m.hostQueued && m.status === "queued" && !waiting.has(m.id) && !startedIds.has(m.id))
        await db.messages.delete(m.id)
    }
    for (const item of items) {
      const mine = byId.get(item.id)
      const next: Message = {
        id: item.id,
        conversationId,
        role: "user",
        content: item.text,
        attachments: mine?.attachments ?? attachmentsOf(item),
        status: "queued",
        statusText: item.error,
        queuePaused: paused || Boolean(item.error),
        createdAt: mine?.createdAt ?? item.createdAt,
        hostQueued: true,
      }
      // Read every 3s while the queue waits; a write that changes nothing still wakes every query.
      if (!mine || JSON.stringify(mine) !== JSON.stringify(next)) await db.messages.put(next)
    }
    for (const item of sent) {
      const mine = byId.get(item.id)
      if (mine && mine.status !== "queued") continue
      const running = ACTIVE_RUN.has(item.runStatus ?? "")
      const inThread = local.some(
        (m) =>
          m.runId === item.runId ||
          (m.status === "done" &&
            m.role === "user" &&
            m.content === item.text &&
            m.createdAt >= item.createdAt - CLOCK_SLACK_MS),
      )
      if (inThread) continue
      if (running && item.runId) {
        if (controllers.has(conversationId)) continue
        const now = nextAt(local)
        await db.messages.put({
          id: item.id,
          conversationId,
          role: "user",
          content: item.text,
          attachments: mine?.attachments ?? attachmentsOf(item),
          status: "done",
          createdAt: now,
        })
        const reply: Message = {
          id: randomId(),
          conversationId,
          role: "assistant",
          content: "",
          tools: [],
          status: "streaming",
          runId: item.runId,
          createdAt: now + 1,
        }
        await db.messages.add(reply)
        follow.push(reply)
      } else if (!running) {
        // The transcript has it now.
        if (mine) await db.messages.delete(mine.id)
        finished = true
      }
    }
  })
  if (follow.length) await updateConversation(conversationId, { updatedAt: Date.now() })
  for (const reply of follow) void resumeReply(reply)
  if (finished) void reconcileHistory(conversationId)
}

const syncingQueue = new Map<string, Promise<void>>()

export function refreshQueue(conversationId: string) {
  let pending = syncingQueue.get(conversationId)
  if (!pending) {
    pending = syncQueue(conversationId)
      .catch(() => undefined)
      .finally(() => syncingQueue.delete(conversationId))
    syncingQueue.set(conversationId, pending)
  }
  return pending
}

/** The plugin starts the next turn within a second or so of the last one ending. */
const HOST_QUEUE_CHECKS_MS = [400, 1500, 4000]

function followHostQueue(conversationId: string) {
  for (const ms of HOST_QUEUE_CHECKS_MS) setTimeout(() => void refreshQueue(conversationId), ms)
}

/** The first message this device holds; the plugin sends its own. */
export async function sendNextQueued(conversationId: string) {
  const next = (await getMessages(conversationId)).find(
    (m) => m.status === "queued" && !m.hostQueued,
  )
  if (next) await sendQueued(next)
}

/**
 * Sends a message this device is still holding — one waiting in the queue, or a send the user asked
 * to try again. One that fails stays where it is, to send again or drop.
 */
export async function sendQueued(message: Message) {
  if (message.hostQueued) {
    const host = await hostOf(message.conversationId)
    if (!host) return
    await queueAction(host.config, host.conversation.hermesSessionId, message.id, "send")
    await refreshQueue(message.conversationId)
    followHostQueue(message.conversationId)
    return
  }
  await sendMessage(message.conversationId, message.content, {
    queuedId: message.id,
    attachments: message.attachments,
  })
}

/** Drops a message this device is still holding, queued or failed, with the text it kept. */
export async function removeQueued(message: Message) {
  if (message.hostQueued) {
    const host = await hostOf(message.conversationId)
    try {
      if (host)
        await queueAction(host.config, host.conversation.hermesSessionId, message.id, "remove")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove the message.")
      return
    }
  }
  await db.messages.delete(message.id)
}

/**
 * Hands a queued message to the reply that's running, which reads it after its current tool calls
 * instead of after it finishes. It then sits in the reply where it was sent.
 */
export async function steerQueued(message: Message) {
  const turn = turns.get(message.conversationId)
  let runId = turn?.draft.runId
  if (message.hostQueued) {
    const host = await hostOf(message.conversationId)
    if (!host) throw new HermesError("This reply can't be steered.")
    const steered = await queueAction(
      host.config,
      host.conversation.hermesSessionId,
      message.id,
      "steer",
    )
    if (typeof steered.run_id === "string") runId = steered.run_id
  } else {
    if (!turn || !runId || message.attachments?.length)
      throw new HermesError("This reply can't be steered.")
    await steerRun(turn.config, runId, message.content)
  }
  await db.messages.delete(message.id)
  if (!turn || turn.draft.runId !== runId) return
  const { draft, touch } = turn
  draft.steers = [
    ...(draft.steers ?? []),
    { id: message.id, text: message.content, contentOffset: draft.content.length, at: Date.now() },
  ]
  touch()
}

/**
 * Sends text straight to the running reply, as a steer. When it can't (the run waits on the user,
 * or the host has no steer route) it queues instead and says so.
 */
export async function steerText(conversationId: string, text: string) {
  const content = text.trim()
  if (!content) return
  await queueMessage(conversationId, content)
  const queued = (await getMessages(conversationId)).findLast(
    (m) => m.status === "queued" && m.content === content,
  )
  if (!queued) return
  try {
    await steerQueued(queued)
  } catch {
    toast.error("Couldn't steer this reply, so it's queued.")
  }
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
  let resolved: ApprovalChoice | "expired" = choice
  try {
    await respondToApproval(serverConfig(profile), message.approval.runId, choice)
  } catch (error) {
    // Nothing waits for an answer any more (answered elsewhere, timed out, the run moved on).
    if (!(error instanceof HermesError && error.code && APPROVAL_GONE.has(error.code))) throw error
    resolved = "expired"
  }
  const active = activeDrafts.get(message.id)
  if (active?.draft.approval) {
    // An answer from another device may have landed meanwhile; it says what really happened.
    if (resolved === "expired" && active.draft.approval.resolved) return
    active.draft.approval = { ...active.draft.approval, resolved }
    active.touch()
  } else {
    await db.messages.update(message.id, { approval: { ...message.approval, resolved } })
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
  await respondToClarify(serverConfig(profile), clarify.runId, {
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
  const interrupted = await db.messages.where("status").equals("streaming").toArray()
  await Promise.all(
    interrupted.map((reply) =>
      reply.runId ? resumeReply(reply) : reattachRun(reply.conversationId),
    ),
  )
}
