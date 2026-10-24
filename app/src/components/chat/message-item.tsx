import { Fragment, Suspense, lazy, memo, useMemo, useState, type ReactNode } from "react"
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
import { AttachmentTile, AttachmentViewer } from "@/components/chat/attachments"
import { AudioRow, MediaGallery, type MediaItem } from "@/components/chat/media-gallery"
import { Markdown } from "@/components/chat/markdown"
import { AgentCards, SubagentResultCard } from "@/components/chat/agent-card"
import { MediaTag } from "@/components/chat/media-image"
import { ClarifyCard, PlanApprovedCard } from "@/components/chat/session-cards"
import { ThinkingLine } from "@/components/chat/thinking-line"
import { ToolGroup } from "@/components/chat/tool-group"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Message as MessageRow, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import { DELEGATE_TOOL } from "@/lib/agents"
import { attachmentUrl } from "@/lib/attachment-url"
import { downloadAttachment, openable, splitAttachments } from "@/lib/attachments"
import { removeQueued, sendQueued } from "@/lib/chat"
import type { Attachment, Message, ToolEvent } from "@/lib/db"
import { describeActivity, formatDuration } from "@/lib/format"
import { COLUMN } from "@/lib/layout"
import { mediaCell, mediaKind } from "@/lib/media-kind"
import { attachmentSources, useMediaSources } from "@/lib/media-source"
import { mediaImages } from "@/lib/media-tags"
import { openuiParts, REPLY_INSET } from "@/lib/openui-block.ts"
import type { InterfaceDraw, ThreadBlock } from "@/lib/openui-thread.ts"
import { runsOf, type ReasoningRun } from "@/lib/thinking"
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
  | { kind: "clarify"; tool: ToolEvent }
  | { kind: "agent"; tool: ToolEvent }
  | ({ kind: "thinking" } & RunPart)

type RunPart = {
  run: ReasoningRun
  /** This run's row streams open: it is the reply's newest run and the reply is still thinking. */
  thinking: boolean
  key: string
}

/** A stretch of a reply: the text between breaks, and the calls started inside it. */
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
function segmentOf(run: ReasoningRun, segments: Segment[], tools: ToolEvent[]) {
  if (!run.afterToolId) return 0
  const found = segments.findIndex((segment) =>
    segment.tools.some((tool) => tool.toolCallId === run.afterToolId),
  )
  if (found >= 0) return found
  const at = tools.find((tool) => tool.toolCallId === run.afterToolId)?.contentOffset ?? 0
  const held = segments.findLastIndex((segment) => at >= segment.start)
  return Math.max(0, held)
}

/**
 * Puts a segment's runs where they happened within it: a run with no anchor opens the segment, and an
 * anchored run follows the part that holds its call — after the whole group when consecutive calls
 * merged into one. Insertion is counted per part, because two runs after the same part arrive in
 * order and a plain "splice after it" would stack the later one above the earlier. A run whose call
 * this segment doesn't draw follows the last call it does draw, and sits at the segment's top when
 * it draws none.
 */
function placeThinking(parts: Part[], runs: RunPart[]): Part[] {
  const row = (run: RunPart): Part => ({ kind: "thinking", ...run })
  const leading = runs.filter((run) => !run.run.afterToolId)
  const placed: Part[] = [...leading.map(row), ...parts]
  const lastCall = placed.findLastIndex(
    (part) => part.kind === "tools" || part.kind === "clarify" || part.kind === "agent",
  )
  const top = leading.length - 1
  const inserted = new Map<number, number>()
  for (const part of runs) {
    const id = part.run.afterToolId
    if (!id) continue
    const found = placed.findIndex(
      (one) =>
        (one.kind === "tools" && one.tools.some((tool) => tool.toolCallId === id)) ||
        ((one.kind === "clarify" || one.kind === "agent") && one.tool.toolCallId === id),
    )
    const at = found >= 0 ? found : lastCall >= 0 ? lastCall : top
    const count = inserted.get(at) ?? 0
    placed.splice(at + 1 + count, 0, row(part))
    inserted.set(at, count + 1)
  }
  return placed
}

/**
 * The margin that pulls a thinking row toward the tool row it sits beside: the two lines are one
 * unit of the thread's account of the work, so only the tool-adjacent side closes up — the gap to
 * the reply's text on the other side stays as it is.
 */
function huggingTools(parts: Part[], index: number) {
  const beside = (part: Part | undefined) => part?.kind === "tools"
  const top = beside(parts[index - 1])
  const bottom = beside(parts[index + 1])
  if (top && bottom) return "-my-2"
  return top ? "-mt-2" : bottom ? "-mb-2" : undefined
}

/**
 * Interleaves a slice of the reply (starting at `start`) with the tools run during it. A clarify
 * call is a card of its own (its question and the answer) rather than a tool row, so is a
 * delegation (the agent it started), and the images a reply sends together — only whitespace
 * between their `MEDIA:<path>` tags — are one gallery part.
 */
function toParts(
  content: string,
  tools: ToolEvent[],
  start: number,
  spans: RowBlock[],
  runs: RunPart[],
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
  const sorted = [...tools].sort(
    (a, b) => (a.contentOffset ?? 0) - (b.contentOffset ?? 0) || a.startedAt - b.startedAt,
  )
  for (const tool of sorted) {
    let at = tool.contentOffset ?? cursor
    for (const span of spans) if (at >= span.at && at < span.end) at = Math.min(span.end, end)
    if (at > cursor) pushText(at)
    const last = parts.at(-1)
    if (tool.tool === "clarify") parts.push({ kind: "clarify", tool })
    else if (tool.tool === DELEGATE_TOOL) parts.push({ kind: "agent", tool })
    else if (last?.kind === "tools") last.tools.push(tool)
    else parts.push({ kind: "tools", tools: [tool] })
  }
  if (cursor < end) pushText(end)
  return placeThinking(parts, runs)
}

function Stats({ message }: { message: Message }) {
  const stats = message.stats
  if (!stats) return null
  return (
    <div className="px-1 text-xs text-muted-foreground/80 tabular-nums">
      {stats.estimated ? "~" : ""}
      {stats.tokens} tokens
      {stats.tokensPerSecond !== undefined && ` · ${stats.tokensPerSecond} tok/s`} ·{" "}
      {formatDuration(stats.durationMs)}
      {message.status === "stopped" && " · stopped"}
    </div>
  )
}

/**
 * A sent message's media and files: the images and clips in one Gallery, a recording in a row of
 * its own, and every other file as a row naming it. Each draws from the bytes this device holds
 * where it has them, else from the host — so a message read on another device still shows what was
 * sent, and one whose host is unreachable still shows this device's own photos. The files this
 * device holds open in a viewer; the ones it doesn't are saved from the host when tapped.
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
  const [viewing, setViewing] = useState<number | null>(null)
  const media = attachments.filter(
    (attachment) => mediaCell(attachment.type, attachment.name) !== "file",
  )
  const sources = useMediaSources(conversationId, attachmentSources(media, attachmentUrl))
  const source = (attachment: Attachment) => sources.get(attachment.id)
  const cell = (attachment: Attachment) => mediaCell(attachment.type, attachment.name)
  const item = (attachment: Attachment): MediaItem => ({
    key: attachment.id,
    kind: mediaKind(attachment.type, attachment.name),
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    src: source(attachment) ?? undefined,
  })
  // A media file whose bytes can't be read anywhere is drawn as the file it is, so a tap still
  // saves it.
  const files = [
    ...attachments.filter((attachment) => cell(attachment) === "file"),
    ...media.filter((attachment) => source(attachment) === null),
  ]
  const drawn = media.filter((attachment) => source(attachment) !== null)
  const viewable = files.filter(openable)
  const download = (attachment: Attachment) =>
    void downloadAttachment(conversationId, attachment).catch(() =>
      toast.error(`Couldn't download ${attachment.name}.`),
    )
  return (
    <div className={cn("flex w-full max-w-full flex-col items-end gap-2", dim && "opacity-60")}>
      <MediaGallery items={drawn.filter((a) => cell(a) === "gallery").map(item)} align="end" />
      {drawn
        .filter((attachment) => cell(attachment) === "audio")
        .map((attachment) => (
          <AudioRow key={attachment.id} item={item(attachment)} />
        ))}
      {files.length > 0 && (
        <div className="flex max-w-full flex-wrap justify-end gap-2">
          {files.map((attachment) => {
            const here = openable(attachment)
            const remote = Boolean(attachment.path)
            return (
              <AttachmentTile
                key={attachment.id}
                attachment={attachment}
                action={remote ? "download" : "open"}
                onOpen={
                  here
                    ? () => setViewing(viewable.findIndex((a) => a.id === attachment.id))
                    : remote
                      ? () => download(attachment)
                      : undefined
                }
              />
            )
          })}
        </div>
      )}
      <AttachmentViewer attachments={viewable} index={viewing} onIndex={setViewing} />
    </div>
  )
}

/** Something the user steered the reply with, where it reached the agent. */
function SteerBubble({ text }: { text: string }) {
  // A steer carrying files reached the model as their markers: the bubble shows the words.
  const said = splitAttachments(text).text
  return (
    <MessageRow align="end" className={COLUMN}>
      <MessageContent className="items-end gap-1">
        <Bubble variant="default" align="end">
          <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
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
}: {
  message: Message
  /** What the row is, before the controls; a failed one is already marked beside its bubble. */
  lead?: ReactNode
  /** The control that sends it, when it waits for one. */
  send?: { label: string; icon: ReactNode }
  /** What the X does, for a screen reader. */
  dismiss: string
}) {
  return (
    <div className="-my-2 flex items-center gap-1 text-xs text-muted-foreground">
      {lead}
      {send && (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 text-xs"
          onClick={() =>
            void sendQueued(message).catch((error) =>
              toast.error(error instanceof Error ? error.message : "Couldn't send your message."),
            )
          }
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
        onClick={() =>
          void removeQueued(message).catch((error) =>
            toast.error(error instanceof Error ? error.message : "Couldn't remove your message."),
          )
        }
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
function FailedActions({ message }: { message: Message }) {
  return (
    <HeldActions
      message={message}
      send={{ label: "Retry", icon: <RotateCcwIcon data-icon="inline-start" /> }}
      dismiss="Cancel failed message"
    />
  )
}

function StatusLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground" aria-live="polite">
      <Spinner className="size-4" />
      <span className="truncate">{text}</span>
    </div>
  )
}

interface MessageItemProps {
  message: Message
  showStats: boolean
  /** What the thread's interface fold drew for this reply's blocks, by their offsets. */
  blocks?: ThreadBlock[]
  /** Whether a reply is streaming in this chat, so queued messages know they'll go on their own. */
  busy?: boolean
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
}: MessageItemProps) {
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
  const thinkingOpen = message.status === "streaming" && !message.content
  const thinking: RunPart[] = useMemo(() => {
    const runs = runsOf({ reasoningRuns: storedRuns, reasoning: storedReasoning })
    return runs.map((run, index) => ({
      run,
      key: `run-${index}`,
      // A span is stamped exactly when its run ends, so a run carrying one is done and stays folded:
      // re-opening it over the call it broke would throw away the number it measured.
      thinking: index === runs.length - 1 && thinkingOpen && run.spanMs === undefined,
    }))
  }, [storedRuns, storedReasoning, thinkingOpen])
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
                  aria-label="Not sent"
                  className="size-4 shrink-0 text-destructive"
                />
              )}
              {message.content && (
                <Bubble variant="default" align="end" className={dim ? "opacity-60" : undefined}>
                  <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
                    {message.content}
                  </BubbleContent>
                </Bubble>
              )}
            </div>
          )}
          {queued && <QueuedActions message={message} paused={paused} />}
          {failed && <FailedActions message={message} />}
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
  const approval = message.approval
  const awaitingApproval = Boolean(approval && !approval.resolved)
  const awaitingClarify = Boolean(message.clarify && !message.clarify.resolved)
  // While this device shows the question as a form, the call's own "waiting" card would repeat it.
  const asking = awaitingClarify
    ? message.tools?.findLast((t) => t.tool === "clarify" && t.status === "running")
    : undefined
  const tools = (message.tools ?? []).filter((t) => t !== asking)
  // The tool group right above already names the running call, so repeating it here is noise.
  const runningTool = tools.some((t) => t.status === "running")

  // An answered approval and each steer split the reply so they sit where they happened: what
  // Hermes said and ran before, the card or the user's message, then what came after.
  const breaks: { key: string; offset: number; time: number; node: ReactNode }[] = []
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
  breaks.sort((a, b) => a.offset - b.offset || a.time - b.time)
  const segments: Segment[] = []
  let start = 0
  let since = -Infinity
  for (const b of [...breaks, { offset: content.length, time: Infinity }]) {
    const end = Math.min(Math.max(b.offset, start), content.length)
    segments.push({
      start,
      end,
      tools: tools.filter((tool) => {
        const at = tool.contentOffset ?? 0
        return (
          (at > start || (at === start && tool.startedAt > since)) &&
          (at < end || (at === end && tool.startedAt <= b.time))
        )
      }),
    })
    start = end
    since = b.time
  }

  const thinkingBySegment = new Map<number, RunPart[]>()
  for (const part of thinking) {
    const at = segmentOf(part.run, segments, tools)
    const batch = thinkingBySegment.get(at)
    if (batch) batch.push(part)
    else thinkingBySegment.set(at, [part])
  }
  // With a row open, the working line would say what the row already says.
  const thinkingProgress =
    thinking.some((part) => part.thinking) && !awaitingApproval && !awaitingClarify

  // A reply's stats come only once it is done and fully revealed, so they never count up.
  const statsShown = showStats && !streaming && !revealing && Boolean(message.stats)
  const statusLine = streaming && !runningTool && !thinkingProgress
  // Empty, the row would still add two of the message's gaps around itself, so it is drawn only
  // once a line shows.
  const footerLines = [
    statusLine && (
      <StatusLine
        key="status"
        text={awaitingApproval ? "Waiting for your approval…" : describeActivity(message)}
      />
    ),
    // An error on a reply that streamed says so plainly: it isn't the bot's answer.
    failed && (
      <div key="failed" className="flex items-start gap-2 px-1 text-[15px] text-destructive">
        {error}
      </div>
    ),
    message.status === "stopped" && !message.content && (
      <div key="stopped" className="px-1 text-xs text-muted-foreground">
        Stopped
      </div>
    ),
    statsShown && <Stats key="stats" message={message} />,
  ].filter(Boolean)
  const footerShown = footerLines.length > 0
  const footer = footerShown && (
    <div className={cn(COLUMN, "flex flex-col gap-3")}>{footerLines}</div>
  )
  return (
    <div className="flex flex-col gap-3">
      {message.subagent && <SubagentResultCard subagent={message.subagent} />}
      {segments.map((segment, i) => {
        const last = i === segments.length - 1
        const parts = toParts(
          content.slice(segment.start, segment.end),
          segment.tools,
          segment.start,
          spans,
          thinkingBySegment.get(i) ?? NO_RUNS,
        )
        return (
          <Fragment key={breaks[i - 1]?.key ?? "start"}>
            {i > 0 && breaks[i - 1].node}
            {(parts.length > 0 || (last && footerShown)) && (
              <AssistantRow
                conversationId={message.conversationId}
                busy={busy}
                ended={!streaming}
                parts={parts}
              >
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

function AssistantRow({
  conversationId,
  busy,
  ended,
  parts,
  children,
}: {
  conversationId: string
  /** A reply is streaming in this chat, so a card that sends (a missed question) waits. */
  busy?: boolean
  /** The reply has been written: the turn it belongs to has ended. */
  ended: boolean
  parts: Part[]
  children?: ReactNode
}) {
  return (
    <MessageRow align="start">
      <MessageContent className="gap-3">
        {parts.map((part, index) =>
          part.kind === "clarify" ? (
            <ClarifyCard
              key={part.tool.toolCallId}
              tool={part.tool}
              conversationId={conversationId}
              busy={busy}
            />
          ) : part.kind === "agent" ? (
            <AgentCards key={part.tool.toolCallId} tool={part.tool} ended={ended} />
          ) : part.kind === "tools" ? (
            <div key={part.tools[0].toolCallId} className={COLUMN}>
              <div className="w-full max-w-xl">
                <ToolGroup tools={part.tools} />
              </div>
            </div>
          ) : part.kind === "thinking" ? (
            <ThinkingLine
              key={part.key}
              reasoning={part.run.text}
              thinking={part.thinking}
              spanMs={part.run.spanMs}
              className={huggingTools(parts, index)}
            />
          ) : part.kind === "media" ? (
            <div key={part.at} className={COLUMN}>
              <MediaTag conversationId={conversationId} paths={part.paths} />
            </div>
          ) : part.kind === "openui" ? (
            <div key={part.at} className={COLUMN}>
              <Suspense fallback={null}>
                <OpenUIBlock
                  source={part.block.source}
                  open={part.block.open}
                  streaming={part.block.streaming}
                  draw={part.block.draw}
                />
              </Suspense>
            </div>
          ) : (
            <Markdown key={part.at} className={cn(REPLY_INSET, "text-[15px] leading-relaxed", COLUMN)}>
              {part.text}
            </Markdown>
          ),
        )}
        {children}
      </MessageContent>
    </MessageRow>
  )
}
