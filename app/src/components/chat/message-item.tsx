import type { ReactNode } from "react"
import { AlertCircleIcon, ClockIcon, SendHorizontalIcon, XIcon } from "lucide-react"

import { ApprovalCard } from "@/components/chat/approval-card"
import { AttachmentTile } from "@/components/chat/attachments"
import { Markdown } from "@/components/chat/markdown"
import { AgentCards } from "@/components/chat/agent-card"
import { ClarifyCard, PlanApprovedCard } from "@/components/chat/session-cards"
import { ToolGroup } from "@/components/chat/tool-group"
import { Bot } from "@/components/bot"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Message as MessageRow, MessageAvatar, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import { DELEGATE_TOOL } from "@/lib/agents"
import { removeQueued, sendMessage } from "@/lib/chat"
import type { Message, ToolEvent } from "@/lib/db"
import { describeActivity, formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useReveal } from "@/lib/reveal"
import { isPlanApproval } from "@/lib/workspace"

type Part =
  | { kind: "text"; at: number; text: string }
  | { kind: "tools"; tools: ToolEvent[] }
  | { kind: "clarify"; tool: ToolEvent }
  | { kind: "agent"; tool: ToolEvent }

/**
 * Interleaves a slice of the reply (starting at `start`) with the tools run during it. A clarify
 * call is a card of its own (its question and the answer) rather than a tool row, and so is a
 * delegation (the agent it started).
 */
function toParts(content: string, tools: ToolEvent[], start: number): Part[] {
  const end = start + content.length
  const parts: Part[] = []
  let cursor = start
  const pushText = (to: number) => {
    const text = content.slice(cursor - start, to - start)
    if (text.trim()) parts.push({ kind: "text", at: cursor, text })
    cursor = to
  }
  const sorted = [...tools].sort((a, b) => (a.contentOffset ?? 0) - (b.contentOffset ?? 0))
  for (const tool of sorted) {
    const at = Math.min(Math.max(tool.contentOffset ?? 0, cursor), end)
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

function QueuedActions({ message, paused }: { message: Message; paused: boolean }) {
  return (
    <div className="-my-2 flex items-center gap-1 text-xs text-muted-foreground">
      <ClockIcon className="size-3.5" />
      <span className="pr-1">{paused ? "Queued, paused" : "Queued"}</span>
      {paused && (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 text-xs"
          onClick={() =>
            void sendMessage(message.conversationId, message.content, {
              queuedId: message.id,
              attachments: message.attachments,
            })
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
        onClick={() => void removeQueued(message.id)}
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

export function MessageItem({
  message,
  showStats,
  botId,
  busy,
  plain,
}: {
  message: Message
  showStats: boolean
  botId?: string
  /** Whether a reply is streaming in this chat, so queued messages know they'll go on their own. */
  busy?: boolean
  /** A project session's thread: no avatars, and the agent's replies sit on the page, not in bubbles. */
  plain?: boolean
}) {
  // Replies type out a word at a time, however Hermes delivers them.
  const content = useReveal(message.role === "assistant" ? message.content : "")
  const revealing = content.length < message.content.length && message.role === "assistant"

  if (message.role === "user") {
    if (plain && isPlanApproval(message.content)) return <PlanApprovedCard />
    const queued = message.status === "queued"
    return (
      <MessageRow align="end">
        <MessageContent className="items-end gap-1">
          {message.attachments?.length ? (
            <div
              className={cn("flex max-w-full flex-wrap justify-end gap-2", queued && "opacity-60")}
            >
              {message.attachments.map((attachment) => (
                <AttachmentTile key={attachment.id} attachment={attachment} />
              ))}
            </div>
          ) : null}
          {message.content && (
            <Bubble variant="default" align="end" className={queued ? "opacity-60" : undefined}>
              <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
                {message.content}
              </BubbleContent>
            </Bubble>
          )}
          {queued && <QueuedActions message={message} paused={!busy} />}
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
  const tools = (message.tools ?? []).filter((t) => t !== asking)
  // The tool group right above already names the running call, so repeating it here is noise.
  const runningTool = tools.some((t) => t.status === "running")

  // An answered approval splits the reply in two so the card sits where it happened:
  // everything Hermes said and ran before asking, the card, then everything after.
  const split = approval?.resolved && approval.contentOffset !== undefined
  const offset = split ? approval.contentOffset! : message.content.length
  const before = content.slice(0, offset)
  const after = content.slice(offset)
  const askedAt = approval?.requestedAt ?? Infinity
  const toolsBefore = split ? tools.filter((t) => t.startedAt <= askedAt) : tools
  const toolsAfter = split ? tools.filter((t) => t.startedAt > askedAt) : []

  const error = (
    <>
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
      <span>{message.statusText ?? "Something went wrong."}</span>
    </>
  )
  // The avatar lines up with the bubble, which has the stats line under it only once the reply is done.
  const statsShown = showStats && !streaming && !revealing && Boolean(message.stats)
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
          {streaming && content && message.statusText && !awaitingApproval && !awaitingClarify && (
            <div className="px-1 text-xs text-muted-foreground">{message.statusText}</div>
          )}
          {/* Last, so the avatar stays level with it however much the turn has said or run. */}
          {streaming && <TypingBubble />}
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

  return (
    <div className="flex flex-col gap-3">
      <AssistantRow
        botId={botId}
        plain={plain}
        lift={!split && statsShown}
        parts={toParts(before, toolsBefore, 0)}
      >
        {!split && footer}
      </AssistantRow>
      {/* A pending approval lives in the composer slot; once answered it sits in the thread, unattributed. */}
      {approval?.resolved && <ApprovalCard message={message} />}
      {split && (
        <AssistantRow
          botId={botId}
          plain={plain}
          lift={statsShown}
          parts={toParts(after, toolsAfter, offset)}
        >
          {footer}
        </AssistantRow>
      )}
    </div>
  )
}

function AssistantRow({
  botId,
  plain,
  lift,
  parts,
  children,
}: {
  botId?: string
  plain?: boolean
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
            <ClarifyCard key={part.tool.toolCallId} tool={part.tool} />
          ) : part.kind === "agent" ? (
            <AgentCards key={part.tool.toolCallId} tool={part.tool} />
          ) : part.kind === "tools" ? (
            <div key={part.tools[0].toolCallId} className="w-full max-w-xl">
              <ToolGroup tools={part.tools} />
            </div>
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
