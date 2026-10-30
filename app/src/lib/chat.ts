import { toast } from "sonner"

import { serverConfig } from "@/lib/connection"
import { FLUSH_INTERVAL_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  db,
  getActiveProfile,
  getMessages,
  getSettings,
  type ApprovalChoice,
  type Attachment,
  type ClarifyAnswers,
  type Conversation,
  type Message,
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
  type ApprovalRequestEvent,
  type ChatMessage,
  type HermesConfig,
  type QueueItem,
  type RunOutcome,
  type StreamHandlers,
  type TurnUsage,
} from "@/lib/hermes"
import { attachmentsText, splitAttachments } from "@/lib/attachment-text"
import { progressReminderNote, progressRemindersShown } from "@/lib/progress-reminder"
import { measureReply } from "@/lib/reply-stats"
import { wireContent } from "@/lib/attachments"
import { refreshContext } from "@/lib/context"
import { refreshChatProviderUsage } from "@/lib/provider-usage"
import {
  foldTranscriptDetails,
  liveTurn,
  RUN_START_SLACK_S,
  summaryRowsOf,
  noteFollowUps,
  patchStats,
  reconcileHistory,
} from "@/lib/history"
import { unknownLastTurn } from "@/lib/model-changes"
import { modelOf, pickOf, wantsPin } from "@/lib/model-pick"
import { askTriage, canTriage, triaging } from "@/lib/triage"
import { takeHostTitle } from "@/lib/title"
import { onTodoTool, refreshTodos } from "@/lib/todos"
import { appendThinking, closeRun, forgetRuns, noteRunThinking } from "@/lib/thinking"
import { clarifyResult } from "@/lib/clarify"
import { quietly } from "@/lib/report"
import { canSteer, midReply } from "@/lib/steer"
import { actionOfPreview } from "@/lib/tools"
import { needsTranscriptWords } from "@/lib/tool-preview"
import { randomId } from "@/lib/utils"
import { knownLiveRun, readLiveRuns } from "@/lib/waiting"
import { onWake } from "@/lib/wake"
import {
  AttachmentError,
  pinFromHost,
  pinModel,
  titleFrom,
  uploadAttachments,
} from "@/lib/send-turn"
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
/**
 * When after a turn the host's title is read again while the chat still holds another one: Hermes
 * titles with a model call in the background, which can land whenever — a slow call, a busy host.
 * The checks run whatever the host streams: a plugin too old to log its `title` events sends them
 * only to the streams open at that moment, so a device that was away has nothing to replay.
 */
const TITLE_RECHECKS_MS = [3000, 10_000, 30_000, 90_000]
/** A reply whose connection gave up is followed again after these waits, the last one repeating. */
const REATTACH_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
const controllers = new Map<string, AbortController>()
/** In-flight reply drafts by message id, so approval answers land in the draft being flushed. */
const activeDrafts = new Map<string, { draft: Message; touch: () => void }>()

async function syncTitle(conversationId: string, config: HermesConfig, sessionId: string) {
  if (await takeHostTitle(conversationId, config, sessionId)) return
  const started = Date.now()
  for (const delay of TITLE_RECHECKS_MS) {
    // Offsets from the turn, not waits between the checks.
    const wait = started + delay - Date.now()
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait))
    if (await takeHostTitle(conversationId, config, sessionId)) return
  }
}

/** A chat's profile, or the active one if its profile has gone. */
async function profileFor(profileId?: string) {
  return (profileId && (await db.profiles.get(profileId))) || getActiveProfile()
}

type Draft = Message & { tools: ToolEvent[] }

export interface Turn {
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
  /** The session and run start a transcript read is asked by, resolved once. */
  source?: Promise<TurnSource | undefined>
  /** The transcript read out now, and whether a caller asked for another pass while it was. */
  read?: { pending?: Promise<Message | undefined>; again?: boolean }
  /** Whether this turn draws reminders, read once. */
  reminders?: Promise<boolean>
}

const turns = new Map<string, Turn>()

/** What about a reply is worth writing at once, rather than with the next batch of text. */
function shape(draft: Draft) {
  const done = draft.tools.filter((t) => t.status !== "running").length
  const { approval, clarify } = draft
  const runs = draft.reasoningRuns
  return [
    draft.status,
    draft.statusText,
    draft.tools.length,
    done,
    approval?.command,
    approval?.resolved,
    clarify?.clarifyId,
    Boolean(clarify?.resolved),
    // A run starting is structural — the row it belongs to is drawn at once — but its text is not.
    runs?.length,
    runs?.at(-1)?.afterToolId,
    draft.reminders?.length,
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
  // A reply's runs are copied run by run: a draft is mutated as thinking arrives, and a row already
  // flushed (which holds these very objects) must not change under the screen.
  const draft: Draft = {
    ...reply,
    tools: [...(reply.tools ?? [])],
    ...(reply.reasoningRuns
      ? { reasoningRuns: reply.reasoningRuns.map((run) => ({ ...run })) }
      : {}),
  }
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

/**
 * The run a reply's thinking was in has ended — a tool call started, the answer began, the turn
 * finished. The span this device watched (its first delta to its last) is kept on the run it belongs
 * to, which the reply's own row carries from here on. A turn picked up mid-thought measures nothing.
 */
function closeThinkingRun(turn: Turn) {
  const runs = turn.draft.reasoningRuns
  if (turn.resumed || !runs?.length) return
  const span = closeRun(turn.draft.id, runs.length - 1)
  if (span === undefined) return
  const next = runs.slice()
  next[next.length - 1] = { ...next[next.length - 1], spanMs: span }
  turn.draft.reasoningRuns = next
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
  if (at >= 0) {
    const responses = clarify.questions.map((question) => ({
      question: question.question,
      choicesOffered: question.choices ?? null,
      answer: answers[question.id] ?? null,
    }))
    tools[at] = { ...tools[at], result: clarifyResult(responses, outcome) }
  }
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

/**
 * Whether this turn's refusals draw their notes as rows, read the first time the turn needs to know
 * and kept for its length: the fold's own answer, never one pushed in when the stream started. A read
 * that fails is today's thread, not a failed reply.
 */
function showsReminders(turn: Turn) {
  turn.reminders ??= getSettings()
    .then(progressRemindersShown)
    .catch(() => false)
  return turn.reminders
}

export function streamHandlers(turn: Turn): StreamHandlers {
  const { draft, touch } = turn
  const watchedHere = !turn.resumed
  const started = () => {
    turn.firstTokenAt ??= Date.now()
  }
  // The call the next run's thinking follows: the newest call that started, and nothing else. A
  // completion, a steer, an approval or a question never moves it — only a call breaks a run.
  let anchor: string | undefined = draft.reasoningRuns?.at(-1)?.afterToolId
  const addThinking = (text: string, wholeBlock: boolean) => {
    // A silent delta or block has nothing to draw, and nothing to time either.
    if (!text) return
    const next = appendThinking(draft.reasoningRuns, anchor, text, wholeBlock)
    draft.reasoningRuns = next
    if (watchedHere) noteRunThinking(draft.id, next.length - 1)
  }
  return {
    onContent(delta) {
      // The answer ended the thinking, so the run it was in is measured now.
      closeThinkingRun(turn)
      started()
      draft.content += delta
      draft.statusText = undefined
      touch()
    },
    onReasoning(delta) {
      started()
      addThinking(delta, false)
      touch()
    },
    onReasoningBlock(text) {
      started()
      addThinking(text, true)
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
      // A run's `tool.completed` carries no call id (`hermes.ts`), so the refusal is matched the way
      // every completion is: by id, else the oldest running call of its tool.
      const note = event.status !== "running" ? progressReminderNote(event.result) : undefined
      if (note !== undefined) {
        const at = existing ? draft.tools.indexOf(existing) : draft.tools.length
        const previous = existing && at > 0 ? draft.tools[at - 1]?.toolCallId : undefined
        const reminder = {
          note,
          contentOffset: existing?.contentOffset ?? draft.content.length,
          toolsBefore: at,
        }
        if (existing) {
          draft.tools = draft.tools.filter((t) => t !== existing)
          // The thinking that follows belongs to the call before this one, as the settled fold places it.
          if (anchor === existing.toolCallId) anchor = previous
          touch()
        }
        void showsReminders(turn).then((shown) => {
          if (!shown) return
          draft.reminders = [...(draft.reminders ?? []), reminder]
          touch()
        })
        return
      }
      if (existing) {
        existing.status = event.status
        if (event.status !== "running") existing.endedAt = Date.now()
        if (event.status === "completed") void onTodoTool(turn.conversationId, existing.tool)
        // A question's full result is written when it's answered; the stream's preview is cut short.
        if (event.result && !(existing.tool === "clarify" && existing.result))
          existing.result = event.result
        // Only a patch whose whole result fit in the preview can be counted here.
        if (existing.tool === "patch" && event.status === "completed" && event.result)
          Object.assign(existing, patchStats(event.result))
        // A call Hermes previews with nothing says what it did only in its arguments, which the
        // transcript holds: once its round is written, the words are read for it — and only while
        // some such row still has none, so a finished round costs no read at all.
        if (
          event.status !== "running" &&
          draft.tools.some((t) => needsTranscriptWords(t.tool) && t.action === undefined)
        )
          void readTranscriptDetails(turn)
      } else {
        // A completion with no start to match still happened; it gets its own card — and it ends
        // whatever thinking was open, the same way a call that started does.
        closeThinkingRun(turn)
        const toolCallId = event.toolCallId ?? `${event.tool}:${Date.now()}`
        // What the call's preview names, stamped as the call arrives: Hermes previews a delegation's
        // control call as `list`, `steer <id>` or `stop <id>`, and a cron call as its action, so the
        // thread can tell them apart — and word them — before the transcript lands, which then
        // corrects it from the arguments themselves (ADR 0053). A tool whose preview says nothing
        // names no action here: the read below is what words it.
        const action = actionOfPreview(event.tool, event.label)
        draft.tools.push({
          toolCallId,
          tool: event.tool,
          emoji: event.emoji,
          label: event.label ?? event.tool,
          status: event.status,
          startedAt: Date.now(),
          ...(action ? { action } : {}),
          ...(event.status !== "running" ? { endedAt: Date.now(), result: event.result } : {}),
          contentOffset: draft.content.length,
        })
        anchor = toolCallId
        // A call Hermes previews with nothing says what it did only in its arguments, which the
        // transcript holds: it is read as the call starts, so the row is worded while it runs.
        if (needsTranscriptWords(event.tool)) void readTranscriptDetails(turn)
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

/** The chat's session and when the turn's run began, as a transcript read is asked by them. */
interface TurnSource {
  conversation: Conversation
  /** The run's start in the host's Unix seconds. */
  since: number
}

/**
 * What a read of the transcript is asked by: the chat's session and when the turn's run began, read
 * once per turn since neither changes under it. The start is the host's own, for a run: this device's
 * clock can't place it among the transcript's rows (a queued message is made before the turn ahead
 * of it ends), so a host that doesn't answer leaves the read for the next round. A chat-completions
 * turn has no run, and its reply was made when it was sent. Undefined for a chat with no session row
 * or a run whose start isn't known — asked again next time, since either may change.
 */
export async function turnSource(turn: Turn) {
  turn.source ??= (async () => {
    const conversation = await db.conversations.get(turn.conversationId)
    if (!conversation) return undefined
    const { runId } = turn.draft
    if (!runId) return { conversation, since: turn.draft.createdAt / 1000 }
    const run = await getRun(turn.config, runId, AbortSignal.timeout(READ_TIMEOUT_MS)).catch(
      quietly("Reading when the run started"),
    )
    return run?.createdAt === undefined ? undefined : { conversation, since: run.createdAt }
  })()
  const source = await turn.source
  if (!source) turn.source = undefined
  return source
}

/**
 * The running turn's reply as its transcript has it, read once at a time and shared: a call that
 * needs it while a read is out joins that read, and asks for one more pass if its own call landed
 * after the read began. A turn with several such calls costs one read per round, not one per call —
 * the transcript is the whole chat, so asking it twice for one question is a read no screen shows.
 */
function transcriptOf(turn: Turn, signal: AbortSignal) {
  turn.read ??= {}
  const read = turn.read
  if (read.pending) {
    read.again = true
    return read.pending
  }
  read.pending = (async () => {
    let reply: Message | undefined
    // Started beside the transcript's own read, not ahead of it.
    const showReminders = showsReminders(turn)
    do {
      read.again = false
      const source = await turnSource(turn)
      if (!source) return reply
      reply = await liveTurn(
        turn.config,
        source.conversation.hermesSessionId,
        source.since,
        signal,
        summaryRowsOf(source.conversation.compactions),
        await showReminders,
      )
    } while (read.again)
    return reply
  })().finally(() => {
    read.pending = undefined
  })
  return read.pending
}

/**
 * Words the running reply's calls by what their arguments said, for a call whose label can't: the
 * events stream carries a call's tool, its preview and its result — never its arguments — and Hermes
 * previews a pull request call with nothing at all, so its row would read as a generic tool until
 * the turn ended and catch-up folded the transcript in. The transcript is written after every tool
 * round, so it's read as such a call starts.
 *
 * The fold is applied to the draft as it stands when the read lands, by call id: a call added or
 * finished while the read was out survives it, where assigning the array the read was asked with
 * would drop that row until a reload.
 */
async function readTranscriptDetails(turn: Turn) {
  if (!turn.config.apiKey) return
  const signal = AbortSignal.any([turn.controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
  const reply = await transcriptOf(turn, signal).catch(quietly("Reading a call's details"))
  const transcript = reply?.tools
  // A turn that ended while the read was out keeps what it ended with.
  if (!transcript || !activeDrafts.has(turn.draft.id)) return
  const tools = foldTranscriptDetails(turn.draft.tools, transcript)
  if (!tools) return
  turn.draft.tools = tools
  turn.touch()
}

/**
 * Reads the turn's progress from the session transcript, for a run whose events can't be read (a
 * Hermes whose events stream the browser's CORS check blocks). Keyed sessions only: Hermes holds
 * the transcript under our session id only when a key is sent.
 */
async function transcriptReader(turn: Turn) {
  const { config, draft, touch, conversationId } = turn
  if (!config.apiKey) return undefined
  if (!(await turnSource(turn))) return undefined
  return async (signal: AbortSignal) => {
    // The same read the calls' details come from: one transcript, one request.
    const reply = await transcriptOf(turn, signal).catch(() => undefined)
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
        void onTodoTool(conversationId, tool.tool)
    // The transcript's runs replace the draft's wholesale, anchored to the calls it also replaces;
    // anything this device measured for the old runs goes with them.
    draft.reasoningRuns = reply.reasoningRuns
    forgetRuns(draft.id)
    if (reply.content) draft.content = reply.content
    if (reply.seams?.length) draft.seams = reply.seams
    // A reminder's whole note comes from the transcript: the stream's preview is cut short.
    if (reply.reminders?.length) draft.reminders = reply.reminders
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
  // Thinking left open when the turn ends is measured too: its span is the deltas this device saw.
  closeThinkingRun(turn)
  if (draft.content || usage) {
    // Hermes's counts when it sent them; a stopped turn never gets them, so they are estimated.
    draft.stats = measureReply({
      text: draft.content,
      toolsUsed: draft.tools.length > 0,
      counted: usage?.completionTokens,
      promptTokens: usage?.promptTokens,
      resumed: turn.resumed,
      startedAt: draft.createdAt,
      firstTokenAt: turn.firstTokenAt,
      endedAt,
    })
  }
  draft.runId = undefined
  draft.runSeq = undefined
  await turn.close()
  // The turn's runs are final: nothing can add to them now, and anything that resumes later notes
  // its run afresh. Freeing the watcher here keeps a long session's entries to its live turns.
  forgetRuns(draft.id)
  await updateConversation(conversationId, { updatedAt: endedAt })
  if (sendFailed) return
  const conversation = await db.conversations.get(conversationId)
  if (conversation?.projectId && draft.status === "done" && conversation.mode === "plan")
    await db.conversations.update(conversationId, { planPending: true })
  await readAfterTurn(conversationId)
}

/**
 * What a finished turn reads again from the plugin, whichever screen streamed it: the context, the
 * provider's limits and the todos at once, and a session's workspace, pull requests and library a
 * moment later, once the plugin's own hooks have recorded the turn.
 */
export async function readAfterTurn(conversationId: string, { turn }: { turn?: number } = {}) {
  noteFollowUps(conversationId)
  void refreshContext(conversationId).catch(quietly("Reading a chat's context"))
  void refreshChatProviderUsage(conversationId).catch(quietly("Reading provider limits"))
  void refreshTodos(conversationId)
  const conversation = await db.conversations.get(conversationId)
  // Hermes titles a session over its first turns, so a screen that counts them reads it then too.
  if (conversation && turn !== undefined && turn <= TITLED_TURNS) {
    const profile = await db.profiles.get(conversation.profileId)
    if (profile?.apiKey)
      void syncTitle(conversationId, serverConfig(profile), conversation.hermesSessionId)
  }
  if (!conversation?.projectId) return
  setTimeout(() => {
    void refreshWorkspace(conversationId)
    void refreshPrs(conversationId, { force: true })
    void refreshLibrary(conversationId)
  }, PLUGIN_SETTLE_MS)
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
export async function requeueSteer(conversationId: string, text: string) {
  const { text: content, attachments } = splitAttachments(text.trim())
  const queued = (await getMessages(conversationId)).find((m) => m.status === "queued")
  await db.messages.add({
    id: randomId(),
    conversationId,
    role: "user",
    content,
    ...(attachments.length ? { attachments } : {}),
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
): Promise<{ status: MessageStatus; sendFailed: boolean; reachedHost: boolean }> {
  const { draft, controller } = turn
  let usage: TurnUsage | undefined
  let pendingSteer: string | undefined
  // The turn failed before anything reached Hermes, so the message can be sent again.
  let sendFailed = false
  // Whether Hermes saw any of it: a pin describes a turn that did.
  let reachedHost = false
  try {
    const result = await start()
    reachedHost = true
    usage = result.usage
    pendingSteer = result.pendingSteer
    if (pendingSteer) dropUnread(draft, pendingSteer)
    if (draft.status === "streaming") draft.status = "done"
  } catch (error) {
    reachedHost = Boolean(draft.runId || draft.content || draft.tools.length)
    if (controller.signal.aborted) {
      draft.status = "stopped"
    } else if (draft.runId && retryable(error)) {
      // Hermes may still be running it: leave the reply streaming and follow it again soon. Until
      // then it holds the chat's catch-up and queue, so the chat's own timer is too slow for it.
      draft.statusText = undefined
      await turn.close()
      reattachLater(turn.conversationId)
      return { status: draft.status, sendFailed, reachedHost }
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
  return { status: draft.status, sendFailed, reachedHost }
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
  if (draft.reminders)
    draft.reminders = draft.reminders.map((one) => ({
      ...one,
      contentOffset: anchor(one.contentOffset),
    }))
}

/** Where the text streamed since the last tool call starts; the run's final answer replaces it. */
function finalTextStart(draft: Draft) {
  return Math.max(
    0,
    ...draft.tools.map((t) => t.contentOffset ?? 0),
    ...(draft.reminders ?? []).map((one) => one.contentOffset),
  )
}

/**
 * Puts the run's final answer in place of the text streamed since the last tool call. They differ
 * when Hermes asked the model to go on after a cut-off or a fragment (a `[System: …]` note the
 * stream never shows): what streamed holds every attempt, the output only the answer.
 */
function settleFinalText(draft: Draft, output: string) {
  const start = finalTextStart(draft)
  const streamed = draft.content.slice(start)
  if (!streamed.trim() || streamed.trim() === output.trim()) return
  // The answer is sometimes the whole turn's text, the words streamed before that call included (a
  // reply a question interrupted, a continuation Hermes joins whole): the reply already reads them,
  // and splicing the answer after its own lead-in draws that lead-in a second time.
  if (draft.content.trim() === output.trim()) return
  const next = draft.content.slice(0, start) + /^\s*/.exec(streamed)![0] + output.trim()
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
  // The first send is what fixes the chat's model; every send after it reads the pick it left.
  const { conversation: pinned, release } = await pinModel(conversation, profile)
  const history = await getMessages(conversationId)
  const now = nextAt(history)
  // The pick in effect, not the profile's advertised default name, which isn't a model id.
  const sent = pickOf(pinned, profile)
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
    // What this device sends the turn with, when the chat has a model picked: its thread places
    // the turn by it where the host's own record doesn't cover it yet.
    ...(sent?.model ? { model: sent.model } : {}),
  }

  try {
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
  } catch (error) {
    // A row the store refused (its quota is full, say) leaves the message where it was, so no turn
    // ran and the pin this send took goes back with it.
    await release?.()
    throw error
  }
  return {
    conversation: pinned,
    profile,
    history,
    userMessage,
    reply,
    release,
    // Nothing on the device names the model this turn will run, so it is asked about afterwards.
    ask: wantsPin(pinned),
  }
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
  const { conversation, profile, history, userMessage, reply, release, ask } = prepared

  const transcript: ChatMessage[] = history
    .filter((m) => m.status === "done" || (m.role === "assistant" && m.content))
    .map((m) => ({ role: m.role, content: attachmentsText(m.content, m.attachments) }))

  const config = serverConfig(profile)
  // A turn can only be divided from the one above it, and the host's record is the only thing that can
  // name a turn this device never picked a model for: ask for it as the turn opens, so a switch shows
  // while a long turn runs. Fired and never awaited, the one read started here. A bot with no key has
  // no session on the host to read.
  if (config.apiKey && unknownLastTurn(history, conversation.modelChanges))
    void refreshContext(conversationId).catch(quietly("Reading a chat's context"))
  const turn = openTurn(conversationId, config, reply, false, controller)
  const { status, sendFailed, reachedHost } = await runTurn(turn, async () => {
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
  // A pin describes a turn that reached Hermes, so a turn that never did takes its own back.
  if (!reachedHost) await release?.()
  // Nothing on the device named the model this turn ran: the host's answer is the one to keep.
  else if (ask) void pinFromHost(conversationId, profile).catch(quietly("Pinning a chat's model"))
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

/**
 * Follows a run this device didn't start (another device's, the plugin's queue, the wake run a
 * finished subagent starts), once the host's shared `runs/live` answer names it for this chat, so
 * the session screen shows what its project does and a question or approval it raises reaches the
 * user. The turn has to be in the transcript with a reply row already, so the live reply is the
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
  // The wake run a finished subagent starts draws no user message, so its reply is the newest
  // after the user's last one rather than the one beside it.
  const reply = messages.slice(at + 1).findLast((m) => m.role === "assistant")
  if (!reply || reply.status === "streaming") return
  // The turn of this run, not an earlier one: the host wrote it after the run started. A turn that
  // opened with a user message counts from that message; a wake turn from its reply.
  const opener = messages[at + 1] === reply && at >= 0 ? messages[at] : reply
  if (opener.createdAt / 1000 < run.createdAt - RUN_START_SLACK_S) return
  // The replay of the run's events builds the reply again from its start.
  const adopted: Message = {
    ...reply,
    content: "",
    tools: [],
    steers: undefined,
    reasoning: undefined,
    reasoningRuns: undefined,
    status: "streaming",
    runId: live.runId,
    runSeq: undefined,
  }
  await db.messages.put(adopted)
  // The reply's runs are rebuilt from the replay, so whatever this device measured for the old ones
  // goes with them.
  forgetRuns(adopted.id)
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
  // A queued turn is often a chat's first send: it fixes the chat's model as a send from here does,
  // and the run the plugin starts carries that chat's model, not the bot's default of the moment.
  const pin = await pinModel(conversation, profile)
  try {
    const workspace = await ensureSessionWorkspace(conversation.id, content || attachments[0].name)
    const sent = attachments.length
      ? await uploadAttachments(config, sessionId, attachments, true)
      : attachments
    const run = runRequest(config, {
      ...modelOf(pin.conversation, profile),
      sessionId,
      messages: [{ role: "user", content: await wireContent(content, sent) }],
      workspaceInstructions: workspace?.instructions,
    })
    const item = await addToQueue(config, sessionId, {
      text: content,
      attachments: sent.map(({ name, type, size, path }) => ({ name, type, size, path })),
      run,
    })
    // The plugin has the turn; a chat with no model to pin gets the host's answer once it has run.
    if (wantsPin(pin.conversation))
      void pinFromHost(conversation.id, profile).catch(quietly("Pinning a chat's model"))
    return { item, sent }
  } catch (error) {
    // The plugin never got the turn, so the chat pins again at its next send rather than holding a
    // model no turn of it ever ran.
    await pin.release?.()
    throw error
  }
}

/**
 * Sends a message typed in a bot's Main thread. The host triages it first when it can: the message
 * wears a triaging state meanwhile, and it stays in Main — sent as any message is — unless the host
 * answers in time that it belongs to an older thread or opens a new one, where the plugin has then
 * queued it. A timeout, a failure or a bot without the feature is just a send to Main. Returns the
 * thread it moved to, and whether the host made that thread for it.
 *
 * It is triaged while Main's own reply runs too, so a message for another thread goes there at once
 * and only one that stays waits in Main, steering the reply or queued as `steer` says (a thread that
 * is mid-reply takes it the same way).
 */
export async function sendFromMain(
  conversationId: string,
  text: string,
  attachments: Attachment[] = [],
  options: { steer?: boolean } = {},
): Promise<{ threadId: string; created: boolean } | undefined> {
  const content = text.trim()
  const host = await hostOf(conversationId)
  // One typed while another is being triaged waits in the queue behind it, untriaged.
  const triaged =
    host?.conversation.main &&
    content &&
    !triaging.has(conversationId) &&
    (await canTriage(host.config))
  if (!host || !triaged) {
    if (triaging.has(conversationId) && content)
      await queueMessage(conversationId, text, attachments)
    else if (content && controllers.has(conversationId))
      await steerOrQueue(conversationId, content, attachments, options.steer)
    else await sendMessage(conversationId, text, { attachments })
    return undefined
  }
  triaging.add(conversationId)
  let heldId: string | undefined
  try {
    // Saved on the host before the ask, as any send does, so whichever thread the message lands in
    // reads them from the paths the message names.
    const sent = attachments.length
      ? await uploadAttachments(host.config, host.conversation.hermesSessionId, attachments, true)
      : attachments
    const held: Message = {
      id: randomId(),
      conversationId,
      role: "user",
      content,
      ...(sent.length ? { attachments: sent } : {}),
      status: "triaging",
      createdAt: nextAt(await getMessages(conversationId)),
    }
    heldId = held.id
    await db.messages.add(held)
    const moved = await askTriage(host, {
      content,
      sent,
      steer: options.steer,
      id: held.id,
    })
    if (moved) return moved
    triaging.delete(conversationId)
    if (controllers.has(conversationId)) {
      // A reply started while the host decided: this goes after it.
      await steerOrQueue(conversationId, content, sent, options.steer)
      await db.messages.delete(held.id)
    } else {
      await sendMessage(conversationId, text, { queuedId: held.id, attachments: sent })
    }
    return undefined
  } finally {
    triaging.delete(conversationId)
    // Whatever happened, the held row doesn't outlive the attempt.
    if (heldId)
      await db.messages
        .where("id")
        .equals(heldId)
        .filter((m) => m.status === "triaging")
        .delete()
  }
}

/** A message sent mid-reply: a steer when the send asked to and it can be one, else queued. */
function steerOrQueue(
  conversationId: string,
  content: string,
  attachments: Attachment[],
  steer?: boolean,
) {
  return midReply(attachments, { steer: Boolean(steer), running: true }) === "steer"
    ? steerText(conversationId, content, attachments)
    : queueMessage(conversationId, content, attachments)
}

/**
 * A triaging message that nothing here is deciding on (the page reloaded or closed mid-triage) was
 * never sent: it becomes a failed message to send again or take back.
 */
export async function settleTriaging(conversationId: string) {
  if (triaging.has(conversationId)) return
  await db.messages
    .where("conversationId")
    .equals(conversationId)
    .filter((m) => m.status === "triaging")
    .modify({ status: "error", statusText: "Not sent" })
}

/** Holds a message until the current reply finishes, and answers the row it added. */
export async function queueMessage(
  conversationId: string,
  text: string,
  attachments: Attachment[] = [],
): Promise<string | undefined> {
  const content = text.trim()
  if (!content && !attachments.length) return undefined
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
      return item.id
    } catch {
      // It waits here instead, and goes from this device.
    }
  }
  await db.messages.add(message)
  return message.id
}

/** Hermes's transcript times are its own clock's, in whole seconds. */
export const CLOCK_SLACK_MS = 5000

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
      // The host's stored text may carry the marker lines the send wrote, which are never the
      // message's words — a row in the thread draws the same way whether it is queued or sent.
      const folded = splitAttachments(item.text)
      // This device's copy first, then what the host answered for, then what the text's own markers
      // name.
      const own = mine?.attachments?.length ? mine.attachments : attachmentsOf(item)
      const carried = { text: folded.text, attachments: own?.length ? own : folded.attachments }
      const next: Message = {
        id: item.id,
        conversationId,
        role: "user",
        content: carried.text,
        attachments: carried.attachments,
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
  // A reply is still streaming, so no turn can start: the message waits its turn like any other
  // send does, keeping the id it has, instead of the control refusing to work. `sendMessage` would
  // return without a word here.
  if (controllers.has(message.conversationId)) {
    const held: Message = { ...message, status: "queued", queuePaused: false }
    delete held.statusText
    await db.messages.put(held)
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
 * The attachments a steer's markers name, saved on the host first: the marker carries the path the
 * model opens, so a file the host hasn't taken yet would name nothing. A save that fails throws,
 * which leaves the message in the queue rather than steering a marker that points nowhere.
 */
async function savedForSteer(message: Message, attachments: Attachment[]) {
  if (!attachments.some((attachment) => !attachment.path && attachment.blob)) return attachments
  const host = await hostOf(message.conversationId)
  if (!host) throw new HermesError("This reply can't be steered.")
  const saved = await uploadAttachments(
    host.config,
    host.conversation.hermesSessionId,
    attachments,
    true,
  )
  await db.messages.update(message.id, { attachments: saved })
  return saved
}

/**
 * Hands a queued message to the reply that's running, which reads it after its current tool calls
 * instead of after it finishes. It then sits in the reply where it was sent.
 */
export async function steerQueued(message: Message) {
  const turn = turns.get(message.conversationId)
  let runId = turn?.draft.runId
  let carried = message.attachments ?? []
  let said: string
  if (message.hostQueued) {
    said = attachmentsText(message.content, carried)
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
    if (!turn || !runId || !canSteer(carried)) throw new HermesError("This reply can't be steered.")
    carried = await savedForSteer(message, carried)
    said = attachmentsText(message.content, carried)
    await steerRun(turn.config, runId, said)
  }
  await db.messages.delete(message.id)
  if (!turn || turn.draft.runId !== runId) return
  const { draft, touch } = turn
  // Hermes hands an unread steer back as the text the model read, so the markers are what the reply
  // keeps for `requeueSteer` to read back as the files they name.
  draft.steers = [
    ...(draft.steers ?? []),
    { id: message.id, text: said, contentOffset: draft.content.length, at: Date.now() },
  ]
  touch()
}

/**
 * Sends a message straight to the running reply, as a steer. It is queued first, so a message the
 * reply can't take stays waiting with everything it carries. When it can't be steered (the run
 * waits on the user, or the host has no steer route) it queues instead and says so.
 */
export async function steerText(
  conversationId: string,
  text: string,
  attachments: Attachment[] = [],
) {
  const content = text.trim()
  if (!content && !attachments.length) return
  const id = await queueMessage(conversationId, content, attachments)
  const queued = id ? await db.messages.get(id) : undefined
  if (!queued) return
  try {
    await steerQueued(queued)
  } catch (error) {
    // A file the host wouldn't take is why it couldn't steer, so its own words come first.
    const because = error instanceof AttachmentError ? `${error.message} ` : ""
    toast.error(`${because}Couldn't steer this reply, so it's queued.`)
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
