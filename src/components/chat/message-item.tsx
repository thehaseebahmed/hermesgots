import type { ReactNode } from "react"
import { AlertCircleIcon } from "lucide-react"

import { ApprovalCard } from "@/components/chat/approval-card"
import { Markdown } from "@/components/chat/markdown"
import { ToolCard } from "@/components/chat/tool-card"
import { Bot } from "@/components/bot"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message as MessageRow, MessageAvatar, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import type { Message, ToolEvent } from "@/lib/db"
import { formatDuration } from "@/lib/format"

type Part = { kind: "text"; at: number; text: string } | { kind: "tools"; tools: ToolEvent[] }

/** Interleaves a slice of the reply (starting at `start`) with the tools run during it. */
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
    if (last?.kind === "tools") last.tools.push(tool)
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
      {stats.tokens} tokens · {stats.tokensPerSecond} tok/s · {formatDuration(stats.durationMs)}
      {message.status === "stopped" && " · stopped"}
    </div>
  )
}

export function TypingBubble({ status }: { status?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Bubble variant="muted">
        <BubbleContent
          className="flex h-10 items-center gap-1.5 px-4"
          aria-label="Hermes is writing"
        >
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="size-2 animate-typing-dot rounded-full bg-muted-foreground/70"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </BubbleContent>
      </Bubble>
      <div
        className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <Spinner className="size-3.5" />
        <span className="truncate">{status || "Writing…"}</span>
      </div>
    </div>
  )
}

export function MessageItem({
  message,
  showStats,
  botId,
}: {
  message: Message
  showStats: boolean
  botId?: string
}) {
  if (message.role === "user") {
    return (
      <MessageRow align="end">
        <MessageContent className="items-end">
          <Bubble variant="default" align="end">
            <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
              {message.content}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </MessageRow>
    )
  }

  const streaming = message.status === "streaming"
  const tools = message.tools ?? []
  const approval = message.approval
  const awaitingApproval = Boolean(approval && !approval.resolved)

  // An answered approval splits the reply in two so the card sits where it happened:
  // everything Hermes said and ran before asking, the card, then everything after.
  const split = approval?.resolved && approval.contentOffset !== undefined
  const offset = split ? approval.contentOffset! : message.content.length
  const before = message.content.slice(0, offset)
  const after = message.content.slice(offset)
  const askedAt = approval?.requestedAt ?? Infinity
  const toolsBefore = split ? tools.filter((t) => t.startedAt <= askedAt) : tools
  const toolsAfter = split ? tools.filter((t) => t.startedAt > askedAt) : []

  const showTyping = streaming && (!message.content || awaitingApproval)
  const typingStatus = awaitingApproval ? "Waiting for your approval…" : message.statusText
  const footer = (
    <>
      {showTyping && <TypingBubble status={typingStatus} />}
      {streaming && message.content && message.statusText && !awaitingApproval && (
        <div className="px-1 text-xs text-muted-foreground">{message.statusText}</div>
      )}
      {message.status === "error" && (
        <Bubble variant="destructive">
          <BubbleContent className="flex items-start gap-2 px-4 py-3">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{message.statusText ?? "Something went wrong."}</span>
          </BubbleContent>
        </Bubble>
      )}
      {message.status === "stopped" && !message.content && (
        <div className="px-1 text-xs text-muted-foreground">Stopped</div>
      )}
      {showStats && !streaming && <Stats message={message} />}
    </>
  )

  return (
    <div className="flex flex-col gap-3">
      <AssistantRow botId={botId} parts={toParts(before, toolsBefore, 0)}>
        {!split && footer}
      </AssistantRow>
      {/* A pending approval lives in the composer slot; once answered it sits in the thread, unattributed. */}
      {approval?.resolved && <ApprovalCard message={message} />}
      {split && (
        <AssistantRow botId={botId} parts={toParts(after, toolsAfter, offset)}>
          {footer}
        </AssistantRow>
      )}
    </div>
  )
}

function AssistantRow({
  botId,
  parts,
  children,
}: {
  botId?: string
  parts: Part[]
  children?: ReactNode
}) {
  return (
    <MessageRow align="start" className="gap-2">
      <MessageAvatar className="mb-6 size-8 bg-transparent">
        <Bot id={botId} className="size-8" />
      </MessageAvatar>
      <MessageContent className="gap-2">
        {parts.map((part) =>
          part.kind === "tools" ? (
            <div key={part.tools[0].toolCallId} className="flex w-full max-w-xl flex-col">
              {part.tools.map((tool) => (
                <ToolCard key={tool.toolCallId} tool={tool} />
              ))}
            </div>
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
