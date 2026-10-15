import { Fragment, memo, useState, type ReactNode } from "react"
import {
  AlertCircleIcon,
  ClockIcon,
  CornerDownRightIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ApprovalCard } from "@/components/chat/approval-card"
import { AttachmentTile, AttachmentViewer } from "@/components/chat/attachments"
import { Markdown } from "@/components/chat/markdown"
import { AgentCards } from "@/components/chat/agent-card"
import { MediaTag } from "@/components/chat/media-image"
import { ClarifyCard, PlanApprovedCard } from "@/components/chat/session-cards"
import { ToolGroup } from "@/components/chat/tool-group"
import { Bot } from "@/components/bot"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Message as MessageRow, MessageAvatar, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import { DELEGATE_TOOL } from "@/lib/agents"
import { openable } from "@/lib/attachments"
import { removeQueued, sendQueued } from "@/lib/chat"
import type { Attachment, Message, ToolEvent } from "@/lib/db"
import { describeActivity, formatDuration } from "@/lib/format"
import { mediaImages } from "@/lib/media-tags"
import { cn } from "@/lib/utils"
import { useReveal } from "@/lib/reveal"
import { isPlanApproval } from "@/lib/workspace"

type Part =
  | { kind: "text"; at: number; text: string }
  | { kind: "media"; at: number; paths: string[] }
  | { kind: "tools"; tools: ToolEvent[] }
  | { kind: "clarify"; tool: ToolEvent }
  | { kind: "agent"; tool: ToolEvent }

/**
 * Interleaves a slice of the reply (starting at `start`) with the tools run during it. A clarify
 * call is a card of its own (its question and the answer) rather than a tool row, so is a
 * delegation (the agent it started), and the images a reply sends together — only whitespace
 * between their `MEDIA:<path>` tags — are one gallery part.
 */
function toParts(content: string, tools: ToolEvent[], start: number): Part[] {
  const end = start + content.length
  const parts: Part[] = []
  let cursor = start
  const pushText = (to: number) => {
    const text = content.slice(cursor - start, to - start)
    if (text.trim())
      for (const part of mediaImages(text)) {
        if (part.kind === "text") {
          if (part.text.trim()) parts.push({ kind: "text", at: cursor + part.at, text: part.text })
        } else parts.push({ kind: "media", at: cursor + part.at, paths: part.paths })
      }
    cursor = to
  }
  const sorted = [...tools].sort(
    (a, b) =>
      (a.contentOffset ?? 0) - (b.contentOffset ?? 0) || a.startedAt - b.startedAt,
  )
  for (const tool of sorted) {
    const at = tool.contentOffset ?? cursor
    if (at > cursor) pushText(at)
    const last = parts.at(-1)
    if (tool.tool === "clarify") parts.push({ kind: "clarify", tool })
    else if (tool.tool === DELEGATE_TOOL) parts.push({ kind: "agent", tool })
    else if (last?.kind === "tools") last.tools.push(tool)
    else parts.push({ kind: "tools", tools: [tool] })
  }
  if (cursor < end) pushText(end)
  return parts
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

/** A sent message's attachments; the ones this device still has open in a viewer. */
function SentAttachments({ attachments, queued }: { attachments: Attachment[]; queued: boolean }) {
  const [viewing, setViewing] = useState<number | null>(null)
  const viewable = attachments.filter(openable)
  return (
    <div className={cn("flex max-w-full flex-wrap justify-end gap-2", queued && "opacity-60")}>
      {attachments.map((attachment) => (
        <AttachmentTile
          key={attachment.id}
          attachment={attachment}
          onOpen={
            openable(attachment)
              ? () => setViewing(viewable.findIndex((a) => a.id === attachment.id))
              : undefined
          }
        />
      ))}
      <AttachmentViewer attachments={viewable} index={viewing} onIndex={setViewing} />
    </div>
  )
}

/** Something the user steered the reply with, where it reached the agent. */
function SteerBubble({ text }: { text: string }) {
  return (
    <MessageRow align="end">
      <MessageContent className="items-end gap-1">
        <Bubble variant="default" align="end">
          <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
            {text}
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

/** Under a queued message: it goes on its own, or waits for a Send once the queue is paused. */
function QueuedActions({ message, paused }: { message: Message; paused: boolean }) {
  return (
    <div className="-my-2 flex items-center gap-1 text-xs text-muted-foreground">
      <ClockIcon className="size-3.5" />
      <span className="pr-1">{message.statusText ?? (paused ? "Queued, paused" : "Queued")}</span>
      {paused && (
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
          <SendHorizontalIcon data-icon="inline-start" />
          Send now
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-11"
        aria-label="Remove queued message"
        onClick={() => void removeQueued(message)}
      >
        <XIcon />
      </Button>
    </div>
  )
}

export function TypingBubble() {
  return (
    <Bubble variant="muted">
      <BubbleContent className="flex h-10 items-center gap-1.5 px-4" aria-label="Hermes is writing">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-2 animate-typing-dot rounded-full bg-muted-foreground/70"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </BubbleContent>
    </Bubble>
  )
}

/** A project session's working line: no bubble, just what the agent is doing. */
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
  /** A simplified chat: the agent's tool calls and its activity line are left out. */
  simple?: boolean
  botId?: string
  /** Whether a reply is streaming in this chat, so queued messages know they'll go on their own. */
  busy?: boolean
  /** A project session's thread: no avatars, and the agent's replies sit on the page, not in bubbles. */
  plain?: boolean
}

export const MessageItem = memo(function MessageItem({
  message,
  showStats,
  botId,
  busy,
  plain,
  simple,
}: MessageItemProps) {
  // Replies type out a word at a time, however Hermes delivers them.
  const content = useReveal(message.role === "assistant" ? message.content : "")
  const revealing = content.length < message.content.length && message.role === "assistant"

  if (message.role === "user") {
    if (plain && isPlanApproval(message.content)) return <PlanApprovedCard />
    const queued = message.status === "queued"
    // The plugin starts a host-queued message itself, so it only waits for a Send when paused.
    const paused = message.hostQueued ? Boolean(message.queuePaused) : !busy
    return (
      <MessageRow align="end">
        <MessageContent className="items-end gap-1">
          {message.attachments?.length ? (
            <SentAttachments attachments={message.attachments} queued={queued} />
          ) : null}
          {message.content && (
            <Bubble variant="default" align="end" className={queued ? "opacity-60" : undefined}>
              <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
                {message.content}
              </BubbleContent>
            </Bubble>
          )}
          {queued && <QueuedActions message={message} paused={paused} />}
        </MessageContent>
      </MessageRow>
    )
  }

  const streaming = message.status === "streaming"
  const approval = message.approval
  const awaitingApproval = Boolean(approval && !approval.resolved)
  const awaitingClarify = Boolean(message.clarify && !message.clarify.resolved)
  // While this device shows the question as a form, the call's own "waiting" card would repeat it.
  const asking = awaitingClarify
    ? message.tools?.findLast((t) => t.tool === "clarify" && t.status === "running")
    : undefined
  const tools = (message.tools ?? []).filter(
    (t) => t !== asking && (!simple || t.tool === "clarify"),
  )
  // The tool group right above already names the running call, so repeating it here is noise.
  const runningTool = tools.some((t) => t.status === "running")
  // Like a person's "typing…", the dots show only while the model thinks or writes: not while a
  // tool runs (hidden ones included) or the turn waits on the user.
  const typing =
    streaming &&
    !awaitingApproval &&
    !awaitingClarify &&
    !message.tools?.some((t) => t.status === "running")

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
  const segments: { start: number; end: number; tools: ToolEvent[] }[] = []
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

  const error = (
    <>
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
      <span>{message.statusText ?? "Something went wrong."}</span>
    </>
  )
  // The avatar lines up with the bubble, which has the stats line under it only once the reply is done.
  const statsShown = showStats && !streaming && !revealing && Boolean(message.stats)
  const statusShown =
    streaming &&
    !simple &&
    Boolean(content) &&
    Boolean(message.statusText) &&
    !awaitingApproval &&
    !awaitingClarify
  const footer = (
    <>
      {plain ? (
        streaming &&
        !runningTool && (
          <StatusLine
            text={awaitingApproval ? "Waiting for your approval…" : describeActivity(message)}
          />
        )
      ) : (
        <>
          {statusShown && (
            <div className="px-1 text-xs text-muted-foreground">{message.statusText}</div>
          )}
          {/* Last, so the avatar stays level with it however much the turn has said or run. */}
          {typing && <TypingBubble />}
        </>
      )}
      {message.status === "error" &&
        (plain ? (
          <div className="flex items-start gap-2 px-1 text-[15px] text-destructive">{error}</div>
        ) : (
          <Bubble variant="destructive">
            <BubbleContent className="flex items-start gap-2 px-4 py-3">{error}</BubbleContent>
          </Bubble>
        ))}
      {message.status === "stopped" && !message.content && (
        <div className="px-1 text-xs text-muted-foreground">Stopped</div>
      )}
      {statsShown && <Stats message={message} />}
    </>
  )

  const footerShown =
    (plain ? streaming : typing || statusShown) ||
    message.status === "error" ||
    (message.status === "stopped" && !message.content) ||
    statsShown
  return (
    <div className="flex flex-col gap-3">
      {segments.map((segment, i) => {
        const last = i === segments.length - 1
        const parts = toParts(
          content.slice(segment.start, segment.end),
          segment.tools,
          segment.start,
        )
        return (
          <Fragment key={breaks[i - 1]?.key ?? "start"}>
            {i > 0 && breaks[i - 1].node}
            {(parts.length > 0 || (last && footerShown)) && (
              <AssistantRow
                conversationId={message.conversationId}
                botId={botId}
                plain={plain}
                busy={busy}
                lift={last && statsShown}
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
 * whole thread with each token. Only a message whose stored value changed renders again.
 */
function sameMessage(a: MessageItemProps, b: MessageItemProps) {
  for (const key of Object.keys({ ...a, ...b }) as (keyof MessageItemProps)[]) {
    if (key !== "message" && a[key] !== b[key]) return false
  }
  return a.message === b.message || JSON.stringify(a.message) === JSON.stringify(b.message)
}

function AssistantRow({
  conversationId,
  botId,
  plain,
  busy,
  lift,
  parts,
  children,
}: {
  conversationId: string
  botId?: string
  plain?: boolean
  /** A reply is streaming in this chat, so a card that sends (a missed question) waits. */
  busy?: boolean
  /** A line sits under the last bubble, so the avatar rises to stay level with it. */
  lift?: boolean
  parts: Part[]
  children?: ReactNode
}) {
  return (
    <MessageRow align="start" className="gap-2">
      {!plain && (
        <MessageAvatar className={cn("size-8 bg-transparent", lift && "mb-6")}>
          <Bot id={botId} className="size-8" />
        </MessageAvatar>
      )}
      <MessageContent className={plain ? "gap-3" : "gap-2"}>
        {parts.map((part) =>
          part.kind === "clarify" ? (
            <ClarifyCard
              key={part.tool.toolCallId}
              tool={part.tool}
              conversationId={conversationId}
              busy={busy}
            />
          ) : part.kind === "agent" ? (
            <AgentCards key={part.tool.toolCallId} tool={part.tool} />
          ) : part.kind === "tools" ? (
            <div key={part.tools[0].toolCallId} className="w-full max-w-xl">
              <ToolGroup tools={part.tools} />
            </div>
          ) : part.kind === "media" ? (
            <MediaTag key={part.at} conversationId={conversationId} paths={part.paths} />
          ) : plain ? (
            <Markdown key={part.at} plain className="px-1 text-[15px] leading-relaxed">
              {part.text}
            </Markdown>
          ) : (
            <Bubble key={part.at} variant="muted" className="max-w-[min(100%,42rem)]">
              <BubbleContent className="px-4 py-3 text-[15px]">
                <Markdown>{part.text}</Markdown>
              </BubbleContent>
            </Bubble>
          ),
        )}
        {children}
      </MessageContent>
    </MessageRow>
  )
}
