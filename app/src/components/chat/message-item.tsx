import { Fragment, Suspense, lazy, memo, useMemo, type ReactNode } from "react"
import {
  AlertCircleIcon,
  ClockIcon,
  CornerDownRightIcon,
  RotateCcwIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ApprovalCard } from "@/components/chat/approval-card"
import { attachmentUrl } from "@/lib/attachment-url"
import { MediaItems, type MediaItem } from "@/components/chat/media-gallery"
import { useCodeFace } from "@/components/chat/code-face"
import { Markdown } from "@/components/chat/markdown"
import { AgentCards } from "@/components/chat/agent-card"
import { SubagentCount } from "@/components/chat/subagent-count"
import { MediaTag } from "@/components/chat/media-image"
import { Compacted } from "@/components/chat/model-change"
import { ClarifyCard, PlanApprovedCard } from "@/components/chat/session-cards"
import { StatusLine } from "@/components/chat/status-line"
import { ThinkingLine } from "@/components/chat/thinking-line"
import { ToolGroup } from "@/components/chat/tool-group"
import { ReminderRow } from "@/components/chat/reminder-row"
import { useRemindersShown } from "@/components/chat/use-reminders-shown"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Message as MessageRow, MessageContent } from "@/components/ui/message"
import { spawnedAgent } from "@/lib/spawn"
import { openAttachment } from "@/lib/attachments"
import { steerWords } from "@/lib/attachment-text"
import { removeQueued, sendQueued } from "@/lib/chat"
import type { Attachment, Message, ProgressReminder, ToolEvent } from "@/lib/db"
import { compactionOf } from "@/lib/compactions"
import type { Compaction } from "@/lib/hermes"
import { describeActivity, formatDuration, WAITING_FOR_APPROVAL } from "@/lib/format"
import { NOT_SENT } from "@/lib/words"
import { COLUMN, REPLY_INSET } from "@/lib/layout"
import { mediaCell, mediaKind, type MediaCell } from "@/lib/media-kind"
import { mediaImages } from "@/lib/media-parts"
import { attachmentSources, mediaRead, useMediaSources } from "@/lib/media-source"
import { mediaStage } from "@/lib/media-stage"
import { openuiParts } from "@/lib/openui-block.ts"
import type { InterfaceDraw, ThreadBlock } from "@/lib/openui-thread.ts"
import {
  mergeThoughtRows,
  placeThinking,
  statusLineOf,
  thinkingRows,
  type RunPart,
} from "@/lib/thinking"
import { cn } from "@/lib/utils"
import { useReveal } from "@/lib/reveal"
import { isPlanApproval } from "@/lib/workspace"

const OpenUIBlock = lazy(() => import("@/components/openui/openui-block"))

type RowBlock = {
  at: number
  end: number
  source: string
  id?: string
  open: boolean
  streaming: boolean
  draw: InterfaceDraw["kind"]
}

type Part =
  | { kind: "text"; at: number; text: string }
  | { kind: "media"; at: number; paths: string[] }
  | { kind: "openui"; at: number; block: RowBlock }
  | { kind: "tools"; tools: ToolEvent[] }
  /** A reminder's note, drawn as a row of its own: never part of the group beside it (ADR 0068). */
  | { kind: "reminder"; reminder: ProgressReminder }
  | { kind: "clarify"; tool: ToolEvent }
  | { kind: "agent"; tool: ToolEvent }
  | ({ kind: "thinking" } & RunPart)

/** One stretch of a reply: the text between breaks, and the calls started inside it. */
type Segment = { start: number; end: number; tools: ToolEvent[] }

/** A segment with no run of its own, so a reply that never thought allocates nothing. */
const NO_RUNS: RunPart[] = []

function rowBlocks(content: string, blocks: ThreadBlock[] | undefined, streaming: boolean) {
  const parts = openuiParts(content)
  const spans: RowBlock[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.kind !== "openui") continue
    const draw = blocks?.find((block) => block.at === part.at)?.draw
    if (!draw) continue
    const span: RowBlock = {
      at: part.at,
      end: parts[i + 1]?.at ?? content.length,
      source: draw.kind === "interface" ? draw.source : part.source,
      open: part.open,
      streaming,
      draw: draw.kind,
    }
    if (part.id !== undefined) span.id = part.id
    spans.push(span)
  }
  return spans
}

/**
 * The segment a run's row belongs to: the one holding the call it follows — or, for a call this
 * thread doesn't draw as a tool row (a question asked as a form), the one that held it.
 */
function segmentOf(part: RunPart, segments: Segment[], tools: ToolEvent[]) {
  const afterToolId = part.afterToolId
  if (!afterToolId) return 0
  const found = segments.findIndex((segment) =>
    segment.tools.some((tool) => tool.toolCallId === afterToolId),
  )
  if (found >= 0) return found
  const at = tools.find((tool) => tool.toolCallId === afterToolId)?.contentOffset ?? 0
  const held = segments.findLastIndex((segment) => at >= segment.start)
  return Math.max(0, held)
}

/**
 * A segment's parts with its runs placed among them: the `Part` constructor for the one placing
 * rule, which is `placeThinking`'s in `thinking.ts` and stays there so both screens share it.
 */
function withThinking(parts: Part[], runs: RunPart[]): Part[] {
  return placeThinking(parts, runs, (run) => ({ kind: "thinking", ...run }))
}

/**
 * A thought row and the tool row it accounts for are one unit of the work, so the upper of the two
 * drops the space the reply puts under it — see `PARTS` for why that is enough.
 */
function huggingWork(part: Part, next: Part | undefined) {
  const work = (one: Part | undefined) =>
    one?.kind === "thinking" || one?.kind === "tools" || one?.kind === "reminder"
  return work(part) && work(next) ? "mb-0" : undefined
}

/**
 * Joins the rows a segment placed with nothing between them: consecutive thought rows are drawn as
 * one, where the first of them was, keeping its key and taking the joined words and the label truth
 * from `mergeThoughtRows` — the one walk that says where a group ends, so nothing here counts rows
 * again. Anything else drawn at a place in the segment — a tool group, a card, text, media, an
 * interface block — is a part of its own, which is what keeps two rows apart, and each segment merges
 * alone, so the steer or approval that split the reply splits its rows too.
 */
function mergeThinking(parts: Part[]): Part[] {
  // The stretch is the drawn value itself, so a row nothing merged with is the object that was placed.
  const rows = mergeThoughtRows(parts.map((part) => (part.kind === "thinking" ? part : null)))
  // Nothing touched anything, which is most replies: drawn as placed, and nothing rebuilt per redraw.
  if (rows.every((one) => one.from === one.to)) return parts
  const merged: Part[] = []
  let at = 0
  for (const { row, from, to } of rows) {
    const head = parts[from]
    // A row is only ever drawn where a thought stretch was placed.
    if (head.kind !== "thinking") continue
    for (; at < from; at++) if (parts[at].kind !== "thinking") merged.push(parts[at])
    // The first stretch's key, so the row survives the merge as the same tree node.
    merged.push({ ...row, kind: "thinking", key: head.key })
    at = to + 1
  }
  for (; at < parts.length; at++) if (parts[at].kind !== "thinking") merged.push(parts[at])
  return merged
}

/**
 * Interleaves a slice of the reply (starting at `start`) with the tools run during it. A clarify
 * call is a card of its own (its question and the answer) rather than a tool row, so is a
 * delegation (the agent it started), and the media a reply sends together — only whitespace between
 * their `MEDIA:<path>` tags — are one part, which draws as one Gallery.
 */
function toParts(
  content: string,
  tools: ToolEvent[],
  start: number,
  spans: RowBlock[],
  runs: RunPart[],
  reminders: ProgressReminder[],
  callsBefore: number,
): Part[] {
  const end = start + content.length
  const parts: Part[] = []
  let cursor = start
  const emit = (from: number, to: number) => {
    const text = content.slice(from - start, to - start)
    if (!text.trim()) return
    for (const part of mediaImages(text)) {
      if (part.kind === "text") {
        if (part.text.trim()) parts.push({ kind: "text", at: from + part.at, text: part.text })
      } else parts.push({ kind: "media", at: from + part.at, paths: part.paths })
    }
  }
  const pushText = (to: number) => {
    let from = cursor
    for (const span of spans) {
      if (span.end <= from || span.at >= to) continue
      if (span.at > from) emit(from, Math.min(span.at, to))
      if (span.at >= from && span.at >= start && span.at < end)
        parts.push({ kind: "openui", at: span.at, block: span })
      from = Math.max(from, Math.min(span.end, to))
    }
    if (to > from) emit(from, to)
    cursor = to
  }
  // Calls and reminders in the order they happened. `order` is the number of calls drawn before the
  // item; a reminder at the same number as a call stands before it, which is where the refused call
  // was. A reminder never joins a run of calls, so the group beside it counts only what ran.
  type Placed =
    | { at: number; order: number; kind: "tool"; tool: ToolEvent }
    | { at: number; order: number; kind: "reminder"; reminder: ProgressReminder }
  const placed: Placed[] = [
    ...tools.map((tool, index): Placed => ({
      at: tool.contentOffset ?? 0,
      order: callsBefore + index,
      kind: "tool",
      tool,
    })),
    ...reminders.map((reminder): Placed => ({
      at: reminder.contentOffset,
      order: reminder.toolsBefore,
      kind: "reminder",
      reminder,
    })),
  ].sort(
    (a, b) =>
      a.at - b.at || a.order - b.order || (a.kind === b.kind ? 0 : a.kind === "reminder" ? -1 : 1),
  )
  for (const entry of placed) {
    let at = entry.kind === "tool" ? (entry.tool.contentOffset ?? cursor) : entry.at
    for (const span of spans) if (at >= span.at && at < span.end) at = Math.min(span.end, end)
    if (at > cursor) pushText(at)
    if (entry.kind === "reminder") {
      parts.push({ kind: "reminder", reminder: entry.reminder })
      continue
    }
    const { tool } = entry
    const last = parts.at(-1)
    if (tool.tool === "clarify") parts.push({ kind: "clarify", tool })
    // A card is drawn only where the call set a subagent to work; a control call is a tool row like
    // any other, which the same classifier decides (ADR 0053).
    else if (spawnedAgent(tool)) parts.push({ kind: "agent", tool })
    else if (last?.kind === "tools") last.tools.push(tool)
    else parts.push({ kind: "tools", tools: [tool] })
  }
  if (cursor < end) pushText(end)
  return mergeThinking(withThinking(parts, runs))
}

function Stats({ message }: { message: Message }) {
  const stats = message.stats
  if (!stats) return null
  return (
    <div
      data-slot="stats"
      className={cn(REPLY_INSET, "text-xs text-muted-foreground/80 tabular-nums")}
    >
      {stats.estimated ? "~" : ""}
      {stats.tokens} tokens
      {stats.tokensPerSecond !== undefined && ` · ${stats.tokensPerSecond} tok/s`} ·{" "}
      {formatDuration(stats.durationMs)}
    </div>
  )
}

/**
 * A sent message's media: every file the message carries, drawn from the URL the host signs for it.
 * A photo, a clip or a recording always keeps its cell — a skeleton until its URL is in, a plain
 * face with a retry after a read that failed — and only a file the Previewer can't show is a row.
 * A kind the host has no copy of is drawn as nothing at all.
 */
function SentAttachments({
  conversationId,
  attachments,
  dim,
}: {
  conversationId: string
  attachments: Attachment[]
  dim: boolean
}) {
  const { states, retry } = useMediaSources(conversationId, attachmentSources(attachments))
  const state = (attachment: Attachment) => states.get(attachment.id)
  // The host's URL is what a file draws from; the bytes this device holds are the fallback for one
  // the host has no copy of — a path it has never been given, or one it answered nothing for.
  const srcOf = (attachment: Attachment) => {
    const url = mediaRead(state(attachment))?.url
    if (url) return url
    const gone = state(attachment)?.status === "gone"
    if (!gone && attachment.path) return undefined
    return attachment.blob ? attachmentUrl(attachment) : undefined
  }
  const note = (attachment: Attachment) => {
    const one = state(attachment)
    return one?.status === "failed" ? one.note : undefined
  }
  const item = (attachment: Attachment, cell: MediaCell): MediaItem => ({
    key: attachment.id,
    kind: mediaKind(attachment.type, attachment.name),
    cell,
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    src: srcOf(attachment),
    state: mediaStage(state(attachment)),
    note: note(attachment),
  })
  // A message the host answered nothing for is not drawn; one this device holds the bytes of is,
  // from those bytes, so a file that never reached the host is still the reader's own.
  const drawn = attachments.filter(
    (attachment) =>
      mediaCell(attachment.type, attachment.name) === "file" ||
      attachment.blob !== undefined ||
      state(attachment)?.status !== "gone",
  )
  const download = (one: MediaItem) => {
    const attachment = attachments.find((it) => it.id === one.key)
    if (attachment) void openAttachment(conversationId, { ...attachment, src: one.src })
  }
  return (
    <div className={cn("flex w-full max-w-full flex-col items-end gap-2", dim && "opacity-60")}>
      <MediaItems
        items={drawn.map((attachment) =>
          item(attachment, mediaCell(attachment.type, attachment.name)),
        )}
        align="end"
        onDownload={download}
        onRetry={(one) => retry(one.key)}
      />
    </div>
  )
}

/** Something the user steered the reply with, where it reached the agent. */
function SteerBubble({ text }: { text: string }) {
  const face = useCodeFace()
  const said = steerWords(text)
  return (
    <MessageRow align="end" className={COLUMN}>
      <MessageContent className="items-end gap-1">
        <Bubble variant="default" align="end">
          <BubbleContent className={cn("px-4 py-2.5 text-[15px] whitespace-pre-wrap", face)}>
            {said}
          </BubbleContent>
        </Bubble>
        <div className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
          <CornerDownRightIcon className="size-3.5" />
          Steered
        </div>
      </MessageContent>
    </MessageRow>
  )
}

/**
 * The row under a message this device is still holding — one waiting in the queue, or a send that
 * failed: what it is, the control that sends it, and the X that drops it.
 */
function HeldActions({
  message,
  lead,
  send,
  dismiss,
  onSend,
  onDismiss,
}: {
  message: Message
  /** What the row is, before the controls; a failed one is already marked beside its bubble. */
  lead?: ReactNode
  /** The control that sends it, when it waits for one. */
  send?: { label: string; icon: ReactNode }
  /** What the X does, for a screen reader. */
  dismiss: string
  onSend?: (message: Message) => void
  onDismiss?: (message: Message) => void
}) {
  return (
    <div className="-my-2 flex items-center gap-1 text-xs text-muted-foreground">
      {lead}
      {send && (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 text-xs"
          onClick={() => {
            if (onSend) return onSend(message)
            void sendQueued(message).catch((error) =>
              toast.error(error instanceof Error ? error.message : "Couldn't send your message."),
            )
          }}
        >
          {send.icon}
          {send.label}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-11"
        aria-label={dismiss}
        onClick={() => {
          if (onDismiss) return onDismiss(message)
          void removeQueued(message).catch((error) =>
            toast.error(error instanceof Error ? error.message : "Couldn't remove your message."),
          )
        }}
      >
        <XIcon />
      </Button>
    </div>
  )
}

/** Under a queued message: it goes on its own, or waits for a Send once the queue is paused. */
function QueuedActions({ message, paused }: { message: Message; paused: boolean }) {
  return (
    <HeldActions
      message={message}
      lead={
        <>
          <ClockIcon className="size-3.5" />
          <span className="pr-1">
            {message.statusText ?? (paused ? "Queued, paused" : "Queued")}
          </span>
        </>
      }
      send={
        paused
          ? { label: "Send now", icon: <SendHorizontalIcon data-icon="inline-start" /> }
          : undefined
      }
      dismiss="Remove queued message"
    />
  )
}

/** Under a message whose send failed: send it again, or take it back. The bubble itself says it
 * didn't go — it stays dim with the mark beside it — so nothing here repeats why. Retry stays live
 * while a reply streams: it queues the message to go next, the way a send from the composer does,
 * rather than sitting there greyed out with nothing to say. */
function FailedActions({
  message,
  actions,
}: {
  message: Message
  actions?: { retry: (id: string) => void; cancel: (id: string) => void }
}) {
  return (
    <HeldActions
      message={message}
      send={{ label: "Retry", icon: <RotateCcwIcon data-icon="inline-start" /> }}
      dismiss="Cancel failed message"
      onSend={actions && ((one) => actions.retry(one.id))}
      onDismiss={actions && ((one) => actions.cancel(one.id))}
    />
  )
}

interface MessageItemProps {
  message: Message
  showStats: boolean
  /** What the thread's interface fold drew for this reply's blocks, by their offsets. */
  blocks?: ThreadBlock[]
  /** Whether a reply is streaming in this chat, so queued messages know they'll go on their own. */
  busy?: boolean
  subagents?: number
  onShowSubagents?: () => void
  /** Whether this row draws the count beside its activity words, rather than leaving it to the foot. */
  subagentsInline?: boolean
  /** The host's record of this chat's compactions, which says how full the context was at each. */
  compactions?: Compaction[]
  /**
   * What Retry and Cancel do for a message that didn't go — one object, so a row is never half
   * wired. A screen with its own send (chat-next) hands its own two in; every other row keeps the
   * current screen's.
   */
  actions?: { retry: (id: string) => void; cancel: (id: string) => void }
}

/**
 * One message in a thread, drawn the same way wherever it is: the agent's reply sits on the page,
 * with no bubble and no picture, and only the user's own message wears a bubble — with the pictures
 * gone, that bubble is the cue for who spoke.
 */
export const MessageItem = memo(function MessageItem({
  message,
  showStats,
  blocks,
  busy,
  subagents,
  onShowSubagents,
  subagentsInline,
  compactions,
  actions,
}: MessageItemProps) {
  const face = useCodeFace()
  const remindersShown = useRemindersShown(Boolean(message.reminders?.length))
  // Replies type out a word at a time, however Hermes delivers them.
  const content = useReveal(message.role === "assistant" ? message.content : "")
  const spans = useMemo(
    () => rowBlocks(message.content, blocks, message.status === "streaming"),
    [message.content, blocks, message.status],
  )
  const revealing = content.length < message.content.length && message.role === "assistant"
  // Folded into rows once per change: a streaming reply redraws many times a second as its text is
  // revealed, and none of that moves a run or opens one.
  const storedRuns = message.reasoningRuns
  const storedReasoning = message.reasoning
  const storedTools = message.tools
  const storedContent = message.content
  const storedStatusText = message.statusText
  // The turn's own state, read once: a reply waiting on the reader is not at work, so the row above
  // it stands down and its line stands whole, with no loader.
  const approval = message.approval
  const awaitingApproval = Boolean(approval && !approval.resolved)
  const awaitingClarify = Boolean(message.clarify && !message.clarify.resolved)
  const waiting = awaitingApproval || awaitingClarify
  const thinking: RunPart[] = useMemo(
    () =>
      thinkingRows({
        reasoningRuns: storedRuns,
        reasoning: storedReasoning,
        content: storedContent,
        status: message.status,
        statusText: storedStatusText,
        waiting,
        tools: storedTools,
      }),
    [
      storedRuns,
      storedReasoning,
      storedTools,
      storedContent,
      storedStatusText,
      waiting,
      message.status,
    ],
  )
  // The turn failed: a user message whose send never got there, or a reply that errored instead of
  // answering. The one kept in the thread waits to be sent again; the other says so plainly.
  const failed = message.status === "error"

  if (message.role === "user") {
    if (isPlanApproval(message.content)) return <PlanApprovedCard />
    const queued = message.status === "queued"
    // A message this device is still holding, waiting its turn or waiting to be sent again, wears the
    // same dimmed bubble: one cue for "not through yet", whether the queue holds it or the send failed.
    // A message the host is triaging wears nothing: while it decides, the message reads as any other
    // one the user sent, and becomes that thread's card or its Moved marker if it is moved.
    const dim = queued || failed
    // The plugin starts a host-queued message itself, so it only waits for a Send when paused.
    const paused = message.hostQueued ? Boolean(message.queuePaused) : !busy
    return (
      <MessageRow align="end" className={COLUMN}>
        <MessageContent className="items-end gap-1">
          {message.attachments?.length ? (
            <SentAttachments
              conversationId={message.conversationId}
              attachments={message.attachments}
              dim={dim}
            />
          ) : null}
          {(message.content || failed) && (
            <div className="flex w-full min-w-0 items-center justify-end gap-1.5">
              {/* A message that didn't go keeps its place but not the strength a delivered one has:
                  it wears the dimmed green a queued message wears, the same cue for a message that
                  isn't through yet, so the two read alike; a mark sits beside the bubble rather than
                  under it, so nothing below a short message reads wider than the message. It says
                  it didn't go and no more. */}
              {failed && (
                <AlertCircleIcon
                  role="img"
                  aria-label={NOT_SENT}
                  className="size-4 shrink-0 text-destructive"
                />
              )}
              {message.content && (
                <Bubble variant="default" align="end" className={dim ? "opacity-60" : undefined}>
                  <BubbleContent
                    className={cn("px-4 py-2.5 text-[15px] whitespace-pre-wrap", face)}
                  >
                    {message.content}
                  </BubbleContent>
                </Bubble>
              )}
            </div>
          )}
          {queued && <QueuedActions message={message} paused={paused} />}
          {failed && <FailedActions message={message} actions={actions} />}
        </MessageContent>
      </MessageRow>
    )
  }

  const error = (
    <>
      <AlertCircleIcon role="img" aria-label="Failed" className="mt-0.5 size-4 shrink-0" />
      <span>{message.statusText ?? "Something went wrong."}</span>
    </>
  )
  const streaming = message.status === "streaming"
  // While this device shows the question as a form, the call's own "waiting" card would repeat it.
  const asking = awaitingClarify
    ? message.tools?.findLast((t) => t.tool === "clarify" && t.status === "running")
    : undefined
  const allTools = message.tools ?? []
  const tools = allTools.filter((t) => t !== asking)
  // The reply's calls in the transcript's own order, which is what a seam counts its `toolsBefore` in:
  // the one call this device hides behind a question form must not shift the ones after it.
  const callIndex = new Map(allTools.map((tool, index) => [tool, index]))
  // The tool group right above already names the running call, so repeating it here is noise.
  const runningTool = tools.some((t) => t.status === "running")

  // An answered approval and each steer split the reply so they sit where they happened: what
  // Hermes said and ran before, the card or the user's message, then what came after.
  const breaks: {
    key: string
    offset: number
    time: number
    toolsBefore?: number
    node: ReactNode
  }[] = []
  if (approval?.resolved && approval.contentOffset !== undefined)
    breaks.push({
      key: "approval",
      offset: approval.contentOffset,
      time: approval.requestedAt ?? Infinity,
      node: <ApprovalCard message={message} />,
    })
  for (const steer of message.steers ?? [])
    breaks.push({
      key: steer.id,
      offset: steer.contentOffset,
      time: steer.at,
      node: <SteerBubble text={steer.text} />,
    })
  for (const seam of message.seams ?? [])
    breaks.push({
      key: seam.id,
      offset: seam.contentOffset,
      time: seam.at,
      toolsBefore: seam.toolsBefore,
      node: <Compacted compaction={compactionOf(seam, compactions)} />,
    })
  breaks.sort((a, b) => a.offset - b.offset || a.time - b.time)
  const segments: Segment[] = []
  let start = 0
  let since: { time: number; toolsBefore?: number } = { time: -Infinity }
  for (const b of [...breaks, { offset: content.length, time: Infinity, toolsBefore: undefined }]) {
    const end = Math.min(Math.max(b.offset, start), content.length)
    segments.push({
      start,
      end,
      tools: tools.filter((tool) => {
        const at = tool.contentOffset ?? 0
        const index = callIndex.get(tool) ?? 0
        // A call at the offset a break sits on is told apart by the transcript's own count where it
        // has one, and by when it started otherwise.
        const after =
          since.toolsBefore !== undefined ? index >= since.toolsBefore : tool.startedAt > since.time
        const before =
          b.toolsBefore !== undefined ? index < b.toolsBefore : tool.startedAt <= b.time
        return (at > start || (at === start && after)) && (at < end || (at === end && before))
      }),
    })
    start = end
    since = { time: b.time, toolsBefore: b.toolsBefore }
  }

  const thinkingBySegment = new Map<number, RunPart[]>()
  for (const part of thinking) {
    const at = segmentOf(part, segments, tools)
    const batch = thinkingBySegment.get(at)
    if (batch) batch.push(part)
    else thinkingBySegment.set(at, [part])
  }
  // Each segment's parts as it draws them, before anything is rendered: a merged row is one row
  // with one key, and a row holds its own state rather than the thread's.
  // Each segment draws the reminders filed under its stretch of the reply; one past the revealed
  // text waits at the end, as the words still being typed do.
  const storedReminders = remindersShown ? message.reminders : undefined
  let callsBefore = 0
  const drawn = segments.map((segment, i) => {
    const lastSegment = i === segments.length - 1
    const reminders = (storedReminders ?? []).filter((reminder) => {
      const at = reminder.contentOffset
      return (at >= segment.start && at < segment.end) || (lastSegment && at >= segment.end)
    })
    const parts = toParts(
      content.slice(segment.start, segment.end),
      segment.tools,
      segment.start,
      spans,
      thinkingBySegment.get(i) ?? NO_RUNS,
      reminders,
      callsBefore,
    )
    callsBefore += segment.tools.length
    return parts
  })
  // A reply's stats come only once it is done and fully revealed, so they never count up.
  const statsShown = showStats && !streaming && !revealing && Boolean(message.stats)
  // The three rows a working reply ends on stand thought, tools, status, in one order that the
  // placing above and this footer below hold between them (ADR 0070). A thought row of this reply
  // that says it is thinking owns that word, so the line stays out of it.
  const rowSaysThinking = drawn.some((parts) =>
    parts.some((part) => part.kind === "thinking" && part.thinking),
  )
  // A subagent at work is the chat's news even while a tool card speaks for this reply. A count is
  // data rather than a word: `0 && <line/>` is the numeral 0, which React would draw, so the count
  // is drawn only where it is above zero.
  const subagentCount = subagents ?? 0
  const shown = subagentCount > 0 && Boolean(subagentsInline) && Boolean(onShowSubagents)
  // What the line says, and whether it stands at all, is the one rule's to decide; what the turn is
  // doing is only the rule's to read while the turn still works.
  const foot = statusLineOf({
    status: message.status,
    waiting,
    runningCall: runningTool,
    thinks: rowSaysThinking,
    activity:
      message.status === "streaming"
        ? awaitingApproval
          ? WAITING_FOR_APPROVAL
          : describeActivity(message)
        : undefined,
    count: subagentCount,
    countShown: shown,
  })
  const suffixed = foot?.count === "suffix"
  const place = suffixed ? "suffix" : foot?.countLoader ? "alone-loading" : "alone"
  // Empty, the row would still add two of the message's gaps around itself, so it is drawn only
  // once the line shows.
  //
  // The line stands last, after everything the reply settled into (ADR 0075): an error or "Stopped"
  // is drawn *instead* of it, and a reply's stats only once it is done — so the only two that can
  // meet are the stats and the count of subagents still at work, and there the live row belongs
  // under the settled one. Nothing of the reply's follows its line, which is what lets a thread one
  // day draw that line in the thread's own place, once, for the count and the catch-up alike.
  const footerLines = [
    // An error on a reply that streamed says so plainly: it isn't the bot's answer.
    failed && (
      <div
        key="failed"
        className={cn(REPLY_INSET, "flex items-start gap-2 text-[15px] text-destructive")}
      >
        {error}
      </div>
    ),
    message.status === "stopped" && (
      <div key="stopped" className={cn(REPLY_INSET, "text-xs text-muted-foreground")}>
        Stopped
      </div>
    ),
    statsShown && <Stats key="stats" message={message} />,
    foot && (
      <StatusLine key="status" text={foot.text} seed={message.id}>
        {foot.count !== "none" && onShowSubagents && (
          <>
            {suffixed && (
              <span aria-hidden data-slot="status-separator" className="text-info">
                ·
              </span>
            )}
            <SubagentCount
              count={subagentCount}
              onOpen={onShowSubagents}
              place={place}
              className={suffixed ? "-my-2.5" : undefined}
            />
          </>
        )}
      </StatusLine>
    ),
  ].filter(Boolean)
  const footerShown = footerLines.length > 0
  const footer = footerShown && (
    <div className={cn(COLUMN, "flex flex-col gap-3")}>{footerLines}</div>
  )
  return (
    <div className="flex flex-col gap-3">
      {drawn.map((parts, i) => {
        const last = i === drawn.length - 1
        return (
          <Fragment key={breaks[i - 1]?.key ?? "start"}>
            {i > 0 && breaks[i - 1].node}
            {(parts.length > 0 || (last && footerShown)) && (
              <AssistantRow conversationId={message.conversationId} busy={busy} parts={parts}>
                {last && footer}
              </AssistantRow>
            )}
          </Fragment>
        )
      })}
      {/* A pending approval lives in the composer slot; one answered with no place in the text follows the reply. */}
      {approval?.resolved && approval.contentOffset === undefined && (
        <ApprovalCard message={message} />
      )}
    </div>
  )
}, sameMessage)

/**
 * A live query hands back fresh objects on every write, so a streaming reply would re-render the
 * whole thread with each token. Only a message whose stored value changed renders again — and the
 * fold's draws, which hold each interface's resolved source, compared the same way by value.
 */
function sameMessage(a: MessageItemProps, b: MessageItemProps) {
  for (const key of Object.keys({ ...a, ...b }) as (keyof MessageItemProps)[]) {
    if (key !== "message" && key !== "blocks" && a[key] !== b[key]) return false
  }
  if (a.message !== b.message && JSON.stringify(a.message) !== JSON.stringify(b.message))
    return false
  return a.blocks === b.blocks || JSON.stringify(a.blocks) === JSON.stringify(b.blocks)
}

/**
 * The reply's parts space themselves rather than the row they sit in: `space-y-3` puts each part's
 * space under it, so the one above a work pair can drop its own and the pair still meets.
 */
const PARTS = "gap-0 space-y-3"

function AssistantRow({
  conversationId,
  busy,
  parts,
  children,
}: {
  conversationId: string
  /** A reply is streaming in this chat, so a card that sends (a missed question) waits. */
  busy?: boolean
  parts: Part[]
  children?: ReactNode
}) {
  // Every part but a card stands on the reply's edge; a card fills its own gutters (ADR 0047).
  const edge = cn(REPLY_INSET, COLUMN)
  return (
    <MessageRow align="start">
      <MessageContent className={PARTS}>
        {parts.map((part, index) => {
          const hug = huggingWork(part, parts[index + 1])
          if (part.kind === "clarify")
            return (
              <ClarifyCard
                key={part.tool.toolCallId}
                tool={part.tool}
                conversationId={conversationId}
                busy={busy}
              />
            )
          if (part.kind === "agent")
            return <AgentCards key={part.tool.toolCallId} tool={part.tool} />
          if (part.kind === "tools")
            return (
              <div key={part.tools[0].toolCallId} className={cn(edge, hug)}>
                <div className="w-full max-w-xl">
                  <ToolGroup tools={part.tools} />
                </div>
              </div>
            )
          if (part.kind === "reminder")
            return (
              <div key={`reminder-${index}`} className={cn(edge, hug)}>
                <div className="w-full max-w-xl">
                  <ReminderRow reminder={part.reminder} />
                </div>
              </div>
            )
          if (part.kind === "thinking")
            return (
              <ThinkingLine
                key={part.key}
                reasoning={part.text}
                thinking={part.thinking}
                spanMs={part.spanMs}
                className={cn(REPLY_INSET, hug)}
              />
            )
          if (part.kind === "media")
            return (
              <div key={part.at} className={edge}>
                <MediaTag conversationId={conversationId} paths={part.paths} />
              </div>
            )
          if (part.kind === "openui")
            return (
              <div key={part.at} className={edge}>
                <Suspense fallback={null}>
                  <OpenUIBlock
                    source={part.block.source}
                    open={part.block.open}
                    streaming={part.block.streaming}
                    draw={part.block.draw}
                  />
                </Suspense>
              </div>
            )
          return (
            <Markdown key={part.at} className={cn(edge, "text-[15px] leading-relaxed")}>
              {part.text}
            </Markdown>
          )
        })}
        {children}
      </MessageContent>
    </MessageRow>
  )
}
