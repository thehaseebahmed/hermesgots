import { serverConfig } from "@/lib/connection"
import { db, getMessages, type Conversation, type Message, type ToolEvent } from "@/lib/db"
import { CLOCK_SLACK_MS, refreshQueue } from "@/lib/chat"
import { FOLLOW_UP_MS, JUST_FOLLOWED_UP_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import { quietly } from "@/lib/report"
import { markResume } from "@/lib/resume-trace"
import { refreshContext } from "@/lib/context"
import { refreshChatProviderUsage } from "@/lib/provider-usage"
import { refreshMoves } from "@/lib/moves"
import { refreshTodos } from "@/lib/todos"
import { refreshLibrary, refreshPrs, refreshWorkspace } from "@/lib/workspace"
import { listSessionMessages, type HermesConfig, type SessionMessage } from "@/lib/hermes"
import { takeHostTitle } from "@/lib/title"
import { splitAttachments } from "@/lib/attachment-text"
import { appendThinking, carrySpans } from "@/lib/thinking"
import { readLiveRuns } from "@/lib/waiting"
import { failureReason } from "@/lib/tools"
import { actionOf, batchWords, controlWords, DELEGATE_TOOL, spawnStamp } from "@/lib/spawn"
import { labelComparable, primaryArg, TODO_TOOLS } from "@/lib/tool-preview"
import { isSubagentResult } from "@/lib/subagent-results.ts"
import { isWakePrompt } from "@/lib/wake-prompt.ts"
import {
  isRestatement,
  isSeamScaffolding,
  REPLAY_HEADER,
  summaryOf,
  seamDrawnContent,
  seamText,
} from "@/lib/compaction-seam"
import { mayHoldArchive, nextWindow, type WindowCursor } from "@/lib/history-window"

/**
 * Message bodies don't sync; every device's turns live in the chat's Hermes session. Opening a chat
 * catches it up from there, and "Load earlier" pages back.
 */

const PAGE = 50
/** Pages to skip past rows sent since the last load, before giving up on finding older ones. */
const MAX_SKIPS = 10

/** Where Hermes names no primary argument: the first of these the call carried is its label. */
const FALLBACK_ARGS = ["query", "text", "command", "path", "name", "prompt", "code", "goal"]
export const MAX_TEXT_CHARS = 4000

const clip = (text: string) =>
  text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text

function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function argsLabel(name: string, args: unknown) {
  if (typeof args === "string") return args.trim()
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const record = args as Record<string, unknown>
  if (!Object.keys(record).length) return ""
  // Like Hermes's preview, so a streamed call and its transcript row read the same.
  if (TODO_TOOLS.has(name))
    return Array.isArray(record.todos)
      ? `${record.todos.length} ${record.todos.length === 1 ? "task" : "tasks"}`
      : ""
  if (name === "clarify" && Array.isArray(record.questions)) {
    const asked = record.questions
      .map((q) =>
        q && typeof q === "object" ? String((q as { question?: unknown }).question ?? "") : "",
      )
      .filter(Boolean)
    if (asked.length) return asked[0]
  }
  // A delegation's control call names no goal, and its arguments as JSON are not words. Hermes's
  // preview gives it `list`, `steer <id>` or `stop <id>`, derived here the same way so the row reads
  // while it streams exactly as it does after a reload (`_delegate_action_preview` in display.py).
  if (name === DELEGATE_TOOL) {
    const control = controlWords(record)
    if (control) return control
    // A batch is worded as Hermes previews it, so its label stays words a row can read. Left to the
    // arguments fallback it is the raw JSON, which a fan-out pushes past MAX_TEXT_CHARS: clipped, the
    // unfinished `tasks` array proved no spawn and the call drew as an ordinary row.
    const batch = batchWords(record)
    if (batch) return batch
  }
  const key = primaryArg(name) ?? FALLBACK_ARGS.find((k) => k in record)
  let value = key ? record[key] : undefined
  if (Array.isArray(value)) value = value[0]
  if (value !== undefined && value !== null && value !== "") return String(value).trim()
  return JSON.stringify(record)
}

/** A call's name and label; `tool_call` is Hermes's bridge to deferred tools, named in its args. */
function describeCall(name: string, args: unknown) {
  if (name === "tool_call" && args && typeof args === "object") {
    const record = args as Record<string, unknown>
    const entries = (Array.isArray(record.calls) ? record.calls : [record]).filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    const inner = entries.map((entry) => {
      const innerName = typeof entry.name === "string" && entry.name ? entry.name : "tool"
      const innerArgs = parseArgs(entry.arguments)
      return { name: innerName, label: argsLabel(innerName, innerArgs), args: innerArgs }
    })
    if (inner.length === 1) return inner[0]
    if (inner.length > 1)
      return {
        name,
        label: inner.map((c) => (c.label ? `${c.name}: ${c.label}` : c.name)).join("\n"),
        args: undefined,
      }
  }
  return { name, label: argsLabel(name, args), args }
}

const countLines = (text: string) =>
  text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0

/** A new file's size, from the call's own content: the result only says how many bytes. */
function writeStats(name: string, args: unknown) {
  if (name !== "write_file" || !args || typeof args !== "object") return undefined
  const content = (args as { content?: unknown }).content
  return typeof content === "string" ? { added: countLines(content), removed: 0 } : undefined
}

/** A patch's size and whether it made a file, from the result's unified diff (before it is clipped). */
export function patchStats(result: string) {
  let parsed: { diff?: unknown; files_created?: unknown } | undefined
  try {
    parsed = JSON.parse(result)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed.diff !== "string") return undefined
  let added = 0
  let removed = 0
  for (const line of parsed.diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  const created = Array.isArray(parsed.files_created) && parsed.files_created.length > 0
  return { added, removed, ...(created ? { created } : {}) }
}

function toolCalls(row: SessionMessage) {
  let calls = row.tool_calls
  if (typeof calls === "string") {
    try {
      calls = JSON.parse(calls)
    } catch {
      calls = null
    }
  }
  return Array.isArray(calls)
    ? calls.map((call, i) => {
        const { name, label, args } = describeCall(
          call?.function?.name ?? "tool",
          parseArgs(call?.function?.arguments),
        )
        return {
          id: call?.id ?? `${row.id}-${i}`,
          name,
          label: clip(label) || name,
          // What the call's arguments said it did, or `spawn` where they set a subagent to work:
          // stamped where they are in hand, so a card is drawn from proof and not from the shape of
          // a label the clip can change (ADR 0053).
          action: actionOf(args) ?? spawnStamp(name, args),
          stats: writeStats(name, args),
        }
      })
    : []
}

/** A user message Hermes handed the agent mid-turn (a steer); it belongs to the reply. */
const isSteer = (row: SessionMessage) => row.role === "user" && row.display_kind === "steer"

/** A steer's own text, without the marker Hermes wraps it in for the model. */
function steerText(content: string) {
  return content
    .trim()
    .replace(/^\[OUT-OF-BAND USER MESSAGE[^\n]*\]\n?/, "")
    .replace(/\n?\[\/OUT-OF-BAND USER MESSAGE\]$/, "")
    .trim()
}

/**
 * A note Hermes writes as a user row to keep a turn going: after a reply was cut off by the network
 * or the output limit, or ended on a fragment. It's for the model, never the user's.
 */
const isNotice = (row: SessionMessage) =>
  row.role === "user" &&
  typeof row.content === "string" &&
  row.content.trimStart().startsWith("[System:")

/** Hermes's `_MIN_CONTINUATION_OVERLAP`: a shorter repeat at a seam is left alone. */
const MIN_OVERLAP = 32

/** How much of `next` repeats the end of `previous` (`_continuation_overlap_length`). */
function overlapLength(previous: string, next: string) {
  if (previous.length < MIN_OVERLAP || next.length < MIN_OVERLAP) return 0
  for (let length = Math.min(previous.length, next.length); length >= MIN_OVERLAP; length--)
    if (previous.endsWith(next.slice(0, length))) return length
  return 0
}

/**
 * The text a notice's answer leaves: the cut-off text and its continuation joined as Hermes joins
 * them for the run's output (`_join_truncated_parts`), or only the new text when the model started
 * over or was asked to send its answer again.
 */
function afterNotice(fragment: string, next: string, notice: string) {
  const head = fragment.trim().slice(0, 64)
  if (!/where you left off|^\[System: Your previous tool call/.test(notice.trimStart())) return next
  if (head && next.trimStart().startsWith(head)) return next
  // Only a stream that was cut mid-way repeats itself at the seam.
  const part = notice.includes("output length limit")
    ? next
    : next.slice(overlapLength(fragment.slice(-next.length), next))
  const gap = fragment && part && !/\s$/.test(fragment) && !/^\s/.test(part) ? "\n" : ""
  return fragment + gap + part
}

/** The rows the host flagged as a compaction's summary, by id, where the plugin said which. */
export type SummaryRows = ReadonlySet<number>

/** The summary rows a chat's compactions name. */
export const summaryRowsOf = (compactions?: { row?: number }[]): SummaryRows | undefined => {
  const rows = compactions?.flatMap((one) => (one.row === undefined ? [] : [one.row]))
  return rows?.length ? new Set(rows) : undefined
}

/**
 * Whether a row is a compaction's summary, and of which kind: `alone` draws nothing and marks where
 * the compaction happened; `merged` is a summary the host folded the user's next message into, which
 * draws that message. The host writes either as a user or an assistant row, never a tool's. Its own
 * flag, where the plugin passed it on, is the authority; the text is read where it hasn't yet.
 */
function summaryKind(row: SessionMessage, summaries?: SummaryRows) {
  if (row.role !== "user" && row.role !== "assistant") return undefined
  const summary = summaryOf(row.content ?? "")
  if (summary)
    return summary.after === "" || summary.after.startsWith(REPLAY_HEADER) ? "alone" : "merged"
  return summaries?.has(row.id) ? "alone" : undefined
}

const isSummaryRow = (row: SessionMessage, summaries?: SummaryRows) =>
  summaryKind(row, summaries) === "alone"

const dropsFromThread = (row: SessionMessage, summaries?: SummaryRows) =>
  isSubagentResult(row) || isSeamScaffolding(row) || isSummaryRow(row, summaries)

/**
 * A compaction writes its summary, then the work it carried forward, then the turn's restated
 * request, then whatever the run did after. The carried copies keep their old times, and the summary
 * is stamped with the moment the compaction ran. Read in that order the request would close a reply
 * that isn't its own, and the summary would sit above work done before it. So the request moves up to
 * open its turn, and the summary moves down to just before the first row written after it — which is
 * where the compaction really happened, mid-reply or between turns. Idempotent.
 */
export function seamOrder(rows: SessionMessage[], summaries?: SummaryRows) {
  const out = [...rows]
  const placed = new Set<number>()
  for (let s = 0; s < out.length; s++) {
    const summary = out[s]
    if (placed.has(summary.id) || !isSummaryRow(summary, summaries)) continue
    placed.add(summary.id)
    const calls = Boolean(summary.tool_calls?.length)
    let at = s
    for (let r = s + 1; r < out.length; r++) {
      const row = out[r]
      if (summaryKind(row, summaries)) break
      // Rows the thread draws nothing of, and steers, are part of the carried work, not a turn.
      if (row.role !== "user" || isNotice(row) || dropsFromThread(row, summaries) || isSteer(row))
        continue
      // A summary the host folded into a call of its own stays with that call's results: only the
      // request moves up, to open the turn above it.
      if (isRestatement(row) && calls) out.splice(s, r - s + 1, row, ...out.slice(s, r))
      else if (isRestatement(row)) {
        out.splice(s, r - s + 1, row, ...out.slice(s + 1, r), summary)
        at = r
      }
      break
    }
    const time = summary.timestamp
    if (!time || calls) continue
    let next = at + 1
    while (
      next < out.length &&
      !summaryKind(out[next], summaries) &&
      out[next].timestamp &&
      out[next].timestamp! <= time
    )
      next++
    if (next > at + 1) out.splice(next - 1, 0, ...out.splice(at, 1))
  }
  return out
}

/**
 * Folds each turn's assistant, tool-call and tool rows into one reply, as streaming shows it. With
 * `live` (a turn still running), a call without its result row stays `running`.
 */
export function toMessages(
  conversationId: string,
  sessionId: string,
  rows: SessionMessage[],
  options: { live?: boolean; summaries?: SummaryRows } = {},
) {
  const { summaries } = options
  // The live read and the archive's display read both hold a compaction as summary, carried copies,
  // then what came after: one order serves both.
  rows = seamOrder(rows, summaries)
  const messages: Message[] = []
  let reply: Message | undefined
  // Where the reply's text since its last tool call starts, and the notice that text was cut by.
  let segment = 0
  let notice: string | undefined
  const newReply = (id: string, createdAt: number) => {
    segment = 0
    notice = undefined
    const message: Message = {
      id,
      conversationId,
      role: "assistant",
      content: "",
      tools: [],
      status: "done",
      createdAt,
    }
    messages.push(message)
    return message
  }
  for (let row of rows) {
    if (row.display_kind === "hidden" || row.role === "system") continue
    // The summary is the model's handoff, not the reply's words or the user's message. Inside a
    // reply it is where the compaction happened, so the reply is drawn split there.
    const kind = summaryKind(row, summaries)
    if (kind === "alone") {
      // Inside a reply, even one that has drawn nothing yet, it splits the reply where it fell.
      if (reply)
        reply.seams = [
          ...(reply.seams ?? []),
          {
            id: `h-${sessionId}-${row.id}`,
            row: row.id,
            contentOffset: reply.content.length,
            toolsBefore: reply.tools?.length ?? 0,
            at: Math.round((row.timestamp ?? 0) * 1000),
          },
        ]
      // Its calls are the reply's own, made after the compaction: only the summary's words go.
      if (!row.tool_calls?.length) continue
      row = { ...row, content: "" }
    }
    // A reply the host folded a summary into keeps only its own words.
    if (kind === "merged" && row.role === "assistant")
      row = { ...row, content: summaryOf(row.content ?? "")!.after }
    if (isNotice(row)) {
      if (reply) notice = row.content ?? ""
      continue
    }
    const createdAt = Math.round((row.timestamp ?? 0) * 1000) || Date.now()
    const id = `h-${sessionId}-${row.id}`
    if (isSteer(row)) {
      reply ??= newReply(id, createdAt)
      reply.steers = [
        ...(reply.steers ?? []),
        {
          id,
          text: splitAttachments(steerText(row.content ?? "")).text,
          contentOffset: reply.content.length,
          at: createdAt,
        },
      ]
      continue
    }
    if (row.role === "user") {
      // A subagent's finding is read in the sub-thread a tap opens, and a compaction's notes are the
      // model's own input: neither is a message here, so neither closes a reply or starts a turn.
      if (dropsFromThread(row)) continue
      reply = undefined
      // The wake run's input is the model's own, never the user's: it draws no message of its own,
      // and the reply it closes is what makes the wake turn's answer a message of its own.
      if (isWakePrompt(row)) continue
      const { text, attachments } = splitAttachments(seamDrawnContent(row))
      messages.push({
        id,
        conversationId,
        role: "user",
        content: text,
        ...(attachments.length ? { attachments } : {}),
        status: "done",
        createdAt,
        hermesRowId: row.id,
        // Its row's own time, kept apart from `createdAt` (which a catch-up may floor): a compaction
        // re-emits this row under a fresh id with the time untouched, and this is what says so.
        ...(row.timestamp ? { hermesAt: createdAt } : {}),
      })
      continue
    }
    reply ??= newReply(id, createdAt)
    if (row.role === "tool") {
      // Match the result to the first unresolved call with this ID. A duplicate
      // call ID (server-side assembly issue) creates two tool events; finding the
      // first running one ensures each attempt gets its own result and the later
      // empty-argument failure doesn't overwrite the earlier successful output.
      const tool = reply.tools?.find(
        (t) => t.toolCallId === row.tool_call_id && t.status === "running",
      )
      if (tool) {
        tool.status = "completed"
        tool.endedAt = createdAt
        if (row.content) {
          tool.result = clip(row.content)
          if (tool.tool === "patch") Object.assign(tool, patchStats(row.content))
          // Hermes doesn't store whether a call failed; its result says, as Hermes itself reads it.
          const error = failureReason(tool.tool, row.content)
          if (error) Object.assign(tool, { status: "failed", error })
        }
      }
      continue
    }
    // The row's reasoning is a stretch of the turn's thinking: it continues the run the last tool
    // call opened, and a row with its own calls below ends that run where those calls start.
    const reasoning = row.reasoning ?? row.reasoning_content
    if (reasoning)
      reply.reasoningRuns = appendThinking(
        reply.reasoningRuns,
        reply.tools?.at(-1)?.toolCallId,
        reasoning,
        true,
      )
    if (row.display_kind === "failed_turn") {
      reply.status = "error"
      reply.statusText = row.content || "Hermes couldn't finish this reply."
    } else if (row.content) {
      const before = reply.content.slice(0, segment)
      const fragment = reply.content.slice(segment).replace(/^\n\n/, "")
      const text = notice && fragment ? afterNotice(fragment, row.content, notice) : undefined
      if (text !== undefined) reply.content = before ? `${before}\n\n${text}` : text
      else reply.content = reply.content ? `${reply.content}\n\n${row.content}` : row.content
    }
    const calls = toolCalls(row)
    if (row.content || calls.length) notice = undefined
    for (const call of calls) {
      const event: ToolEvent = {
        toolCallId: call.id,
        tool: call.name,
        label: call.label,
        status: "running",
        startedAt: createdAt,
        contentOffset: reply.content.length,
        ...(call.action ? { action: call.action } : {}),
        ...call.stats,
        ...(call.stats ? { created: true } : {}),
      }
      reply.tools = [...(reply.tools ?? []), event]
      segment = reply.content.length
    }
  }
  if (!options.live) {
    // A finished turn: a call whose result row is missing still ended.
    for (const m of messages)
      for (const t of m.tools ?? [])
        if (t.status === "running") Object.assign(t, { status: "completed", endedAt: t.startedAt })
  }
  return messages.filter(
    (m) =>
      m.role === "user" ||
      m.content ||
      m.tools?.length ||
      m.status === "error" ||
      m.reasoningRuns?.length,
  )
}

/**
 * The runs to write for a turn the transcript also knows: the host's runs, each keeping the span this
 * device measured for the same run in the same place (a span never travels, so the transcript has
 * none), and the local runs when the transcript holds no thinking at all.
 */
function mergedRuns(transcript: Message, local: Message | undefined) {
  const kept = carrySpans(transcript.reasoningRuns, local?.reasoningRuns) ?? local?.reasoningRuns
  return kept ? { reasoningRuns: kept } : {}
}

/** A streamed call's preview, which Hermes cuts at 500 characters ("..." marks the cut). */
const isPreview = (tool: ToolEvent) =>
  tool.result !== undefined && tool.result.length >= 500 && tool.result.endsWith("...")

function withTranscriptToolOffsets(local: Message, transcript: Message) {
  const tools = transcript.tools ?? []
  if (!tools.length || local.content === transcript.content) return tools
  const segments: string[] = []
  let from = 0
  for (const tool of tools) {
    const offset = Math.max(from, Math.min(transcript.content.length, tool.contentOffset ?? from))
    segments.push(transcript.content.slice(from, offset))
    from = offset
  }
  segments.push(transcript.content.slice(from))

  const locations: Array<{ start: number; end: number } | undefined> = []
  let searchFrom = 0
  for (const segment of segments) {
    const text = segment.trim()
    if (!text) {
      locations.push(undefined)
      continue
    }
    const start = local.content.indexOf(text, searchFrom)
    if (start < 0) locations.push(undefined)
    else {
      const end = start + text.length
      locations.push({ start, end })
      searchFrom = end
    }
  }

  return tools.map((tool, index) => {
    if (tool.contentOffset === undefined) return tool
    // Match the text immediately around the call in order; if only one side survives the rewrite,
    // anchor there. If neither does, use the reply start rather than inventing a scaled position.
    const before = locations[index]
    let after = locations[index + 1]
    for (let next = index + 2; !after && next < locations.length; next++) after = locations[next]
    const contentOffset = before?.end ?? after?.start ?? 0
    return { ...tool, contentOffset }
  })
}

/**
 * What streamed calls only learn from the transcript: their edits' size, the whole result where the
 * stream sent a cut preview, and the action their arguments named — the authority on what the call
 * did, where the live stream could only read its preview.
 *
 * A call is matched to its transcript row in two passes, so no row can take a detail that belongs to
 * another: the same tool and the same label first, then — only where both sides hold the same number
 * of calls of that tool — the k-th row to the k-th call, which is the one pairing that is a placement
 * rather than a guess. A call with no counterpart keeps what it has, so a fold can say less than the
 * transcript and never something the transcript didn't say (ADR 0053).
 */
export function foldTranscriptDetails(local: ToolEvent[], transcript: ToolEvent[]) {
  const matched = new Map<number, ToolEvent>()
  const taken = new Set<number>()
  for (const [index, tool] of local.entries()) {
    if (!labelComparable(tool.tool)) continue
    const at = transcript.findIndex(
      (found, i) => !taken.has(i) && found.tool === tool.tool && found.label === tool.label,
    )
    if (at < 0) continue
    taken.add(at)
    matched.set(index, transcript[at])
  }
  // A call whose label can't agree with the transcript's is paired by its place in the run — a todo
  // call, whose preview is worded differently, and a call Hermes previews with nothing at all.
  for (const name of new Set(local.map((tool) => tool.tool))) {
    if (labelComparable(name)) continue
    const mine = local.flatMap((tool, index) =>
      tool.tool === name && !matched.has(index) ? [index] : [],
    )
    const theirs = transcript.flatMap((tool, index) =>
      tool.tool === name && !taken.has(index) ? [index] : [],
    )
    // A truncated list of one side's calls can't place them: leaving the row as it stands says less
    // about the call, where pairing it by ordinal would claim a detail from another call.
    if (mine.length !== theirs.length) continue
    mine.forEach((index, k) => {
      taken.add(theirs[k])
      matched.set(index, transcript[theirs[k]])
    })
  }
  let changed = false
  const tools = local.map((tool, index) => {
    const found = matched.get(index)
    if (!found) return tool
    const needsStats = tool.added === undefined
    // A question's result is written here when it's answered, whole.
    const needsResult = isPreview(tool) && tool.tool !== "clarify"
    // The transcript read the arguments; a preview that read like a control call was a guess.
    const needsAction = tool.action !== found.action
    if (!needsStats && !needsResult && !needsAction) return tool
    const next = { ...tool }
    if (needsStats && found.added !== undefined)
      Object.assign(next, { added: found.added, removed: found.removed, created: found.created })
    if (needsResult && found.result) {
      next.result = found.result
      if (found.error) next.error = found.error
    }
    if (needsAction) {
      if (found.action === undefined) delete next.action
      else next.action = found.action
    }
    if (next.added === tool.added && next.result === tool.result && next.action === tool.action)
      return tool
    changed = true
    return next
  })
  return changed ? tools : undefined
}

/**
 * The transcript's tool details folded into the reply this device already drew, for a turn it kept:
 * what the stream recorded stays, and its calls gain what only the transcript carries.
 */
function withReplyDetails(local: Message, reply: Message | undefined) {
  if (!reply) return
  const tools =
    local.tools?.length && reply.tools?.length
      ? foldTranscriptDetails(local.tools, reply.tools)
      : undefined
  const seams =
    reply.seams?.length && JSON.stringify(reply.seams) !== JSON.stringify(local.seams)
      ? reply.seams
      : undefined
  if (!tools && !seams) return
  return { ...local, ...(tools ? { tools } : {}), ...(seams ? { seams } : {}) }
}

/**
 * The reply so far of the running turn that `userContent` started, from the transcript Hermes
 * writes after every tool round. For a client that can't read the run's events.
 */
export async function liveTurn(
  config: HermesConfig,
  sessionId: string,
  userContent: string,
  signal?: AbortSignal,
  summaries?: SummaryRows,
) {
  const rows = new Map<number, SessionMessage>()
  for (let page = 0; page <= MAX_SKIPS; page++) {
    const batch = await listSessionMessages(config, sessionId, {
      limit: PAGE,
      offset: page * PAGE,
      signal,
    })
    for (const row of batch) rows.set(row.id, row)
    const sorted = seamOrder(
      [...rows.values()].sort((a, b) => a.id - b.id),
      summaries,
    )
    // The row carries the attachments' lines after the text the user typed, and a compaction
    // restates the request under its header: both are the same turn.
    const start = sorted.findLastIndex(
      (row) =>
        isTurnStart(row, summaries) &&
        splitAttachments(seamText(row.content ?? "")).text === userContent,
    )
    const summary = sorted.findLastIndex((row) => isSummaryRow(row, summaries))
    // A restated request follows the work the compaction carried forward, which sits under a summary
    // an older page holds: the read goes on until it is in.
    const carriedAbove = start >= 0 && isRestatement(sorted[start]) && summary < 0
    // A compaction can archive the request altogether: the turn is then what follows the summary.
    const resumed =
      start < 0 &&
      summary >= 0 &&
      !sorted.slice(summary + 1).some((row) => isTurnStart(row, summaries))
    const turn =
      // Past the last page the turn is read from its request, as it was before the summary mattered.
      carriedAbove && batch.length === PAGE && page < MAX_SKIPS
        ? undefined
        : start >= 0
          ? sorted.slice(start)
          : resumed
            ? sorted.slice(summary + 1)
            : undefined
    if (turn)
      return toMessages("", sessionId, turn, { live: true, summaries }).find(
        (m) => m.role === "assistant",
      )
    if (batch.length < PAGE) return undefined
  }
  return undefined
}

async function connection(conversation: Conversation) {
  const profile = await db.profiles.get(conversation.profileId)
  // Hermes only keys a session by our id when a key is sent, so keyless chats have nothing to load.
  return profile?.apiKey ? serverConfig(profile) : undefined
}

const reconciling = new Map<string, Promise<number>>()

/**
 * Pulls Hermes's auto-generated session title into the chat, as a turn's own checks and the live
 * stream do. A long-running turn (a code session) may finish on Hermes after the app closed;
 * without this, the first-line slice stays forever.
 */
async function refreshTitle(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation || conversation.titleEdited) return
  const config = await connection(conversation)
  if (config) await takeHostTitle(conversationId, config, conversation.hermesSessionId)
}

const followedUp = new Map<string, number>()
const caughtUp = new Map<string, number>()

/** A turn that just ended read the chat's context and todos itself. */
export function noteFollowUps(conversationId: string) {
  followedUp.set(conversationId, Date.now())
}

/** Whether the chat caught up with its transcript within `ms`. */
export const caughtUpWithin = (conversationId: string, ms: number) =>
  Date.now() - (caughtUp.get(conversationId) ?? -Infinity) < ms

/**
 * The reads that follow a catch-up: the title, context use, the provider's limits, todos, and a
 * session's workspace and pull requests. They run when the transcript moved or the server said the
 * session changed (a mode or a plan moves without a row), the first time, and otherwise every
 * `FOLLOW_UP_MS`, not on every catch-up of an idle chat. A turn that ended just now read them.
 */
function followUps(conversationId: string, moved: boolean) {
  const since = Date.now() - (followedUp.get(conversationId) ?? -Infinity)
  if (since < JUST_FOLLOWED_UP_MS || (!moved && since < FOLLOW_UP_MS)) return
  followedUp.set(conversationId, Date.now())
  void Promise.all([
    refreshTitle(conversationId),
    refreshContext(conversationId),
    refreshChatProviderUsage(conversationId),
    refreshTodos(conversationId),
    refreshMoves(conversationId),
    refreshWorkspace(conversationId),
    refreshLibrary(conversationId),
    refreshPrs(conversationId),
  ]).catch(quietly("Reading a chat's details"))
}

/**
 * Catches a chat up with its transcript on Hermes, which holds every device's turns. An empty chat
 * gets the newest page; otherwise only turns newer than the last one seen arrive. Turns streamed on
 * this device are kept as they are (they carry stats and approvals Hermes doesn't store) and only
 * matched to their rows. Resolves to how many messages arrived, without waiting for the follow-up
 * reads, so a send waits on the transcript alone.
 */
export function reconcileHistory(conversationId: string, { changed = false } = {}) {
  let pending = reconciling.get(conversationId)
  if (!pending) {
    const tip = () => db.conversations.get(conversationId).then((c) => c?.hermesTip)
    // The queue first: a turn the plugin started from it is followed live, not loaded half done.
    pending = Promise.all([tip(), refreshQueue(conversationId)])
      .then(async ([before]) => {
        const added = await reconcile(conversationId)
        if (added === null) return 0
        caughtUp.set(conversationId, Date.now())
        markResume("open-chat-caught-up")
        followUps(conversationId, changed || added > 0 || (await tip()) !== before)
        return added
      })
      .finally(() => reconciling.delete(conversationId))
    reconciling.set(conversationId, pending)
  }
  return pending
}

/**
 * A turn starts at the user's own message. A wake prompt (`isWakePrompt`) stays one even though its
 * row draws nothing: the wake run is a turn of this conversation, and the reply that answers it is
 * grouped — and followed live — as that turn's own.
 */
const isTurnStart = (row: SessionMessage, summaries?: SummaryRows) =>
  row.role === "user" &&
  row.display_kind !== "hidden" &&
  !isSteer(row) &&
  !isNotice(row) &&
  !dropsFromThread(row, summaries)

const isStreaming = (messages: Message[]) => messages.some((m) => m.status === "streaming")

/** A user message's transcript row; rows loaded before matching existed carry it in their id. */
function rowIdOf(message: Message, sessionId: string) {
  if (message.hermesRowId !== undefined) return message.hermesRowId
  const prefix = `h-${sessionId}-`
  return message.id.startsWith(prefix) ? Number(message.id.slice(prefix.length)) : undefined
}

const byRowId = (rows: Map<number, SessionMessage>) =>
  [...rows.values()].sort((a, b) => a.id - b.id)

/** Whether a chat shows anything for a row: hidden and system rows aren't worth a "Load earlier". */
const isShown = (row: SessionMessage) => row.display_kind !== "hidden" && row.role !== "system"

/**
 * The rows from the start of the turn holding `tip` to the newest, or for an empty chat the newest
 * whole turns: a reply is named after its first row, so one cut by the page edge would load again,
 * whole and under another id, once its start was read, and show twice.
 */
async function fetchTail(config: HermesConfig, sessionId: string, tip?: number) {
  const rows = new Map<number, SessionMessage>()
  for (let page = 0; page <= MAX_SKIPS; page++) {
    const batch = await listSessionMessages(config, sessionId, { limit: PAGE, offset: page * PAGE })
    for (const row of batch) rows.set(row.id, row)
    const sorted = byRowId(rows)
    const start =
      tip === undefined
        ? sorted.findIndex((row) => isTurnStart(row))
        : sorted.findLastIndex((row) => row.id <= tip && isTurnStart(row))
    const end = batch.length < PAGE
    if (start >= 0 || end) {
      const from = Math.max(start, 0)
      const full = tip === undefined && (!end || sorted.slice(0, from).some(isShown))
      return { rows: sorted.slice(from), full }
    }
  }
  return { rows: byRowId(rows), full: tip === undefined }
}

/** With `liveTail`, the last turn is still running: its calls without a result are still at work. */
function turnsOf(
  conversationId: string,
  sessionId: string,
  rows: SessionMessage[],
  liveTail = false,
  summaries?: SummaryRows,
) {
  const groups: SessionMessage[][] = []
  for (const row of seamOrder(rows, summaries)) {
    if (isTurnStart(row, summaries) || !groups.length) groups.push([row])
    else groups[groups.length - 1].push(row)
  }
  return groups.map((group, i) => {
    const live = liveTail && i === groups.length - 1
    const messages = toMessages(conversationId, sessionId, group, { live, summaries })
    const user = messages.find((m) => m.role === "user")
    const reply = messages.find((m) => m.role === "assistant")
    // A catch-up keeps one reply per turn. The turn a wake run opened has no user message at all, and
    // its reply is still the thread's next message.
    return {
      user,
      reply,
      wake: isWakePrompt(group[0]),
      // A compaction's carried rows have lower ids than the request they now follow.
      rows: {
        first: Math.min(...group.map((row) => row.id)),
        last: Math.max(...group.map((row) => row.id)),
      },
    }
  })
}

/** The transcript row a reply loaded from Hermes is named after. */
function replyRowOf(message: Message, sessionId: string) {
  const prefix = `h-${sessionId}-`
  if (message.role !== "assistant" || !message.id.startsWith(prefix)) return undefined
  const id = Number(message.id.slice(prefix.length))
  return Number.isInteger(id) ? id : undefined
}

/**
 * Replies loaded from Hermes for rows `first` to `last`, other than `keep`: a turn's part loaded on
 * its own when a page edge cut it, which the whole turn replaces. A streaming one is left alone.
 */
function partsOf(
  current: Message[],
  sessionId: string,
  rows: { first: number; last: number },
  keep?: string,
) {
  return current
    .filter((m) => {
      const row = replyRowOf(m, sessionId)
      return (
        row !== undefined &&
        row >= rows.first &&
        row <= rows.last &&
        m.id !== keep &&
        m.status !== "streaming"
      )
    })
    .map((m) => m.id)
}

/**
 * Keeps older messages before `ceiling` (the chat's first message), in their order: their times are
 * the host's clock and the chat's may be this device's.
 */
function placeBefore(messages: Message[], ceiling?: number) {
  if (ceiling === undefined) return messages
  for (let i = messages.length - 1; i >= 0; i--) {
    messages[i].createdAt = Math.min(messages[i].createdAt, ceiling - 1)
    ceiling = messages[i].createdAt
  }
  return messages
}

/** Whether the transcript ends on calls whose results aren't in: still at work, or never ended. */
function awaitingResults(rows: SessionMessage[]) {
  const last = rows.findLast(isShown)
  return Boolean(last?.role === "assistant" && toolCalls(last).length)
}

/**
 * Whether the host still runs the session, so a question or command the last turn waits on reads
 * as waiting, not as never answered, until the run is followed. Asked fresh: a chat opened from a
 * notification has heard nothing yet. Needs the plugin.
 */
async function runningOnHost(config: HermesConfig, sessionId: string) {
  if (!config.apiKey) return false
  return Boolean((await readLiveRuns(config))?.runIds[sessionId])
}

/**
 * A message this device drew for the seam outlives the fold that stopped drawing it, and no turn above
 * ever visits it: dropped here, on the catch-up that runs whether or not the host has written since.
 */
async function scrubSeamBubbles(local: Message[], sessionId: string) {
  const stale = local.filter(
    (m) => m.role === "user" && rowIdOf(m, sessionId) !== undefined && isSeamScaffolding(m),
  )
  if (stale.length) await db.messages.bulkDelete(stale.map((m) => m.id))
}

async function reconcile(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return 0
  const config = await connection(conversation)
  if (!config) return 0
  const local = await getMessages(conversationId)
  // The streaming reply catches up when it ends.
  if (isStreaming(local)) return null
  const sessionId = conversation.hermesSessionId
  await scrubSeamBubbles(local, sessionId)
  const tip = local.length ? conversation.hermesTip : undefined
  if (tip !== undefined) {
    const [newest] = await listSessionMessages(config, sessionId, { limit: 1, offset: 0 })
    if (!newest || newest.id === tip) return 0
  }
  const { rows, full } = await fetchTail(config, sessionId, tip)
  if (!rows.length) return 0
  const live = awaitingResults(rows) && (await runningOnHost(config, sessionId))
  const turns = turnsOf(
    conversationId,
    sessionId,
    rows,
    live,
    summaryRowsOf(conversation.compactions),
  )
  return await db.transaction("rw", db.messages, db.conversations, async () => {
    const current = await getMessages(conversationId)
    if (isStreaming(current)) return null
    const byId = new Map(current.map((m) => [m.id, m]))
    const known = new Map<number, Message>()
    for (const m of current) {
      const rowId = m.role === "user" ? rowIdOf(m, sessionId) : undefined
      if (rowId !== undefined) known.set(rowId, m)
    }
    const unmatched = current.filter(
      (m) => m.role === "user" && m.status === "done" && rowIdOf(m, sessionId) === undefined,
    )
    // Each fetched row's own time, in ms: what a turn is recognised by when a compaction has
    // re-emitted its rows under fresh ids.
    const hostAt = new Map(
      rows.map((row) => [row.id, row.timestamp ? Math.round(row.timestamp * 1000) : undefined]),
    )
    let next = 0
    // The local turns this pass has already paired with a row: a compaction's copy of a turn must not
    // pair with a local message that an earlier row of the same page already took.
    const adopted = new Set<string>()
    // Inserted turns sort after what precedes them on Hermes, whatever this device's clock says.
    let floor = 0
    const turnEnd = (user: Message) => {
      let end = current.indexOf(user)
      while (current[end + 1] && current[end + 1].role !== "user") end++
      return current[end].createdAt + 1
    }
    const writes: Message[] = []
    const parts: string[] = []
    // Every row this pass inserts lands after what precedes it on Hermes, whatever this device's
    // clock says: what the floor is for.
    const put = (message: Message) => {
      message.createdAt = Math.max(message.createdAt, floor)
      writes.push(message)
      floor = message.createdAt + 1
    }
    for (const { user, reply, wake, rows: range } of turns) {
      if (!user) {
        // The turn a wake run opened: the prompt draws nothing, and the answer it brought is the
        // thread's next message — a reply of its own, after the turn it closed.
        if (wake && reply) {
          parts.push(...partsOf(current, sessionId, range, reply.id))
          put(reply)
          continue
        }
        // A turn longer than every page fetchTail reads: only an empty chat shows its tail.
        if (!current.length && reply) writes.push(reply)
        continue
      }
      parts.push(...partsOf(current, sessionId, range, reply?.id))
      const seen = known.get(user.hermesRowId!)
      if (seen) {
        floor = turnEnd(seen)
        if (seen.id === user.id && reply) {
          // A turn loaded from Hermes earlier, possibly before it finished: refresh its reply, keeping
          // the spans this device measured on the runs that are still the same runs. The rows this
          // pass read may start inside the turn — a tail read does — so `partsOf`'s range is not the
          // turn's own, and the reply this device holds for it is named after the first row it wrote.
          const local = byId.get(reply.id)
          const createdAt = local?.createdAt ?? Math.max(reply.createdAt, floor)
          writes.push({ ...reply, createdAt, ...mergedRuns(reply, local) })
          floor = createdAt + 1
        }
        // A device that drew the seam row before the fold read it keeps that text: the row folds to
        // the user's request now, so the message follows the fold rather than staying as it was.
        if (seen.content !== user.content)
          writes.push({
            ...seen,
            content: user.content,
            ...(user.attachments?.length ? { attachments: user.attachments } : {}),
          })
        continue
      }
      const at = user.hermesRowId !== undefined ? hostAt.get(user.hermesRowId) : undefined
      const match = unmatched.findIndex((m, i) => i >= next && m.content === user.content)
      if (match >= 0) {
        next = match + 1
        adopted.add(unmatched[match].id)
        writes.push({
          ...unmatched[match],
          hermesRowId: user.hermesRowId,
          ...(at !== undefined ? { hermesAt: at } : {}),
        })
        floor = turnEnd(unmatched[match])
        // A turn streamed here without its events has no tool calls; the transcript's fill it in.
        const local = current[current.indexOf(unmatched[match]) + 1]
        if (local?.role === "assistant" && !local.tools?.length && reply?.tools?.length) {
          const content =
            local.content.trim() && reply.content.trimEnd().endsWith(local.content.trim())
              ? reply.content
              : local.content
          const restored = { ...local, content }
          writes.push({
            ...restored,
            tools: withTranscriptToolOffsets(restored, reply),
            ...mergedRuns(reply, local),
            steers: local.steers ?? reply.steers,
            ...(reply.seams?.length ? { seams: reply.seams } : {}),
          })
        } else if (local?.role === "assistant") {
          const merged = withReplyDetails(local, reply)
          if (merged) writes.push(merged)
        }
        continue
      }
      // Hermes's compaction carries the newest turns forward under fresh row ids with their text and
      // times untouched, so a turn this device already holds comes back looking new. Adopt it where it
      // stands — remembering the row it now has, so the next catch-up matches by id — rather than
      // adding a second copy of it around whatever the user sent since.
      const carried =
        at === undefined
          ? undefined
          : current.find(
              (m) =>
                !adopted.has(m.id) &&
                m.role === "user" &&
                m.status === "done" &&
                m.content === user.content &&
                (m.hermesAt !== undefined
                  ? m.hermesAt === at
                  : Math.abs(m.createdAt - at) <= CLOCK_SLACK_MS),
            )
      if (carried) {
        adopted.add(carried.id)
        writes.push({ ...carried, hermesRowId: user.hermesRowId, hermesAt: at })
        floor = turnEnd(carried)
        const local = current[current.indexOf(carried) + 1]
        if (local?.role === "assistant" && local.status !== "streaming") {
          const merged = withReplyDetails(local, reply)
          if (merged) writes.push(merged)
        }
        continue
      }
      user.createdAt = Math.max(user.createdAt, floor)
      writes.push(user)
      floor = user.createdAt + 1
      if (reply) put(reply)
    }
    await db.messages.bulkDelete(parts)
    await db.messages.bulkPut(writes)
    await db.conversations.update(conversationId, {
      hermesTip: rows[rows.length - 1].id,
      // Where the window's edge is, so a reader who reaches the top can walk the rows above it. A
      // window that begins at the live transcript's first row is the chat's own edge only if
      // nothing was archived above it, and only the host says whether anything was: the reach asks
      // before it reads a display order. So this names the live numbering, and the archive is where
      // that numbering runs out — and a window left without an edge, by a host that couldn't answer
      // or a reach that found nothing, is given one again here rather than left unreachable.
      ...(current.length === 0
        ? {
            olderThan: full
              ? { kind: "live" as const, id: rows[0].id, offset: rows.length }
              : { kind: "archive" as const, id: rows[0].id },
          }
        : {}),
    })
    return writes.filter((m) => !byId.has(m.id)).length
  })
}

const loadingEarlier = new Map<string, Promise<void>>()

/** Rows one step of the window asks for: the host's page cap. */
const STEP = 500
/** Steps one visit takes before it leaves the rest for the next reach, so a host that keeps
 *  answering with rows can't hold a reader in a loop. */
const MAX_STEPS = 40

/**
 * Loads the whole turns before the oldest row the device holds, placed before the chat's first
 * message. A chat opened before turns were loaded whole may start with a reply whose start was cut
 * off by the page edge: that turn is loaded again, whole, in its place.
 *
 * It keeps going until the chat's own first row is in, because a compacted chat's older rows are
 * archived rather than deleted: the live transcript runs out where the archive begins, and only the
 * host's display read carries the rest.
 */
export function loadEarlierHistory(conversationId: string) {
  let pending = loadingEarlier.get(conversationId)
  if (!pending) {
    // After a catch-up under way, which may be setting where the chat's history starts: a tap while
    // it runs isn't lost.
    pending = Promise.resolve(reconciling.get(conversationId))
      .catch(() => undefined)
      .then(() => loadEarlier(conversationId))
      .finally(() => loadingEarlier.delete(conversationId))
    loadingEarlier.set(conversationId, pending)
  }
  return pending
}

async function loadEarlier(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation?.olderThan) return
  const config = await connection(conversation)
  if (!config) return
  const sessionId = conversation.hermesSessionId
  // Only the host can say whether anything was archived above the window, and its answer is kept
  // with the chat by the read the rest of the app makes: a reach asks once, not every time.
  let compactions = conversation.compactions
  if (compactions === undefined) {
    await refreshContext(conversationId)
    compactions = (await db.conversations.get(conversationId))?.compactions
  }
  const archive = mayHoldArchive(compactions)
  let cursor: WindowCursor = conversation.olderThan
  // The archive is only ever entered at its own newest end. A host that said the chat was never
  // compacted has nothing there to read, so the edge goes; one that couldn't answer has said
  // nothing at all, and the window stands as it is for the next reach to ask about.
  if (cursor.kind === "archive" && !archive) {
    if (compactions !== undefined)
      await db.conversations.update(conversationId, { olderThan: undefined })
    return
  }
  let offset = cursor.kind === "live" ? cursor.offset : 0
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
  const list = (from: number) =>
    listSessionMessages(config, sessionId, {
      limit: STEP,
      offset: from,
      signal,
      ...(cursor.kind === "archive" ? { includeCompacted: true } : {}),
    })
  /** The turn `cut` belongs to, read whole: a window an older version left at a page edge starts
   *  with a reply whose turn began above it, and the live numbering's offset starts past that
   *  start. The rows are at the newest end, so the read starts there and pages back until the next
   *  turn's start is in. */
  async function turnFrom(cut: number) {
    const rows = new Map<number, SessionMessage>()
    for (let page = 0; page <= MAX_SKIPS; page++) {
      for (const row of await list(page * STEP)) if (row.id >= cut) rows.set(row.id, row)
      const sorted = byRowId(rows)
      if (sorted[0]?.id <= cut && sorted.some((row) => row.id > cut && isTurnStart(row))) break
    }
    const sorted = byRowId(rows)
    const next = sorted.findIndex((row) => row.id > cut && isTurnStart(row))
    return next < 0 ? sorted : sorted.slice(0, next)
  }
  const local = await getMessages(conversationId)
  const cutRow = local[0]?.role === "assistant" ? replyRowOf(local[0], sessionId) : undefined
  // A window an older version opened mid-turn starts with a reply whose turn began above it. Its
  // turn is read whole here and laid down with the first step's rows — one `toMessages` call for
  // both, since a turn's rows only make one reply when they are read as one run.
  const rest = cutRow === undefined ? [] : await turnFrom(cutRow)
  // Every row the device holds, and every row the walk adds: either numbering can answer the same
  // row, so one set across the walk is what keeps it landing once.
  const held = new Set<number>()
  for (const message of local) {
    const row =
      message.role === "user" ? rowIdOf(message, sessionId) : replyRowOf(message, sessionId)
    if (row !== undefined) held.add(row)
  }
  for (const row of rest) held.add(row.id)
  // The window's oldest message, which each step's rows are placed above.
  let windowFirst = local[0]
  // The cut reply is replaced once the rows that stand for it are in, and only then.
  let mend = rest.length ? { delete: local[0].id, ceiling: local[1]?.createdAt } : undefined
  for (let step = 0; step < MAX_STEPS; step++) {
    const pages: SessionMessage[][] = []
    let end = false
    for (let page = 0; page <= 2 * MAX_SKIPS; page++) {
      const batch = await list(offset)
      const kept: SessionMessage[] = []
      for (const row of batch) {
        if (held.has(row.id)) continue
        held.add(row.id)
        kept.push(row)
      }
      // A read counts its offset back from the newest end but returns each page oldest first, so
      // the first page sits nearest the window and every page after it is older: the pages go in
      // front of one another to come out in the host's order.
      if (kept.length) pages.unshift(kept)
      offset += batch.length
      end = batch.length < STEP
      if (end) break
    }
    // The rows the step kept, in the order the host gave them, floored below the window's own edge.
    // The host keeps the times it gave them — carried ones included, under their fresh ids — and a
    // host whose clock ran ahead of this device's would have newer ones still.
    const older = pages.flat()
    const rows = mend ? [...older, ...rest] : older
    const messages = toMessages(conversationId, sessionId, rows, {
      summaries: summaryRowsOf(compactions),
    })
    const ceiling = mend ? mend.ceiling : windowFirst?.createdAt
    const next = nextWindow(cursor, { oldest: older[0]?.id, end, offset }, archive)
    await db.transaction("rw", db.messages, db.conversations, async () => {
      // The cut part goes only once the rows that stand for it are in, in the same write.
      if (older.length) {
        if (mend) await db.messages.delete(mend.delete)
        await db.messages.bulkPut(placeBefore(messages, ceiling))
      }
      await db.conversations.update(conversationId, { olderThan: next })
    })
    mend = undefined
    if (!next) return
    if (messages.length) windowFirst = messages[0]
    const was = cursor
    cursor = next
    if (next.kind === "live") offset = next.offset
    else if (was.kind === "live") offset = 0
  }
}
