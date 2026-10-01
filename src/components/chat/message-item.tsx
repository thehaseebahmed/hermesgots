import { AlertCircleIcon } from "lucide-react"

import { ApprovalCard } from "@/components/chat/approval-card"
import { Markdown } from "@/components/chat/markdown"
import { ToolCard } from "@/components/chat/tool-card"
import { Mascot } from "@/components/mascot"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message as MessageRow, MessageAvatar, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import type { Message } from "@/lib/db"
import { formatDuration } from "@/lib/format"

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

export function MessageItem({ message, showStats }: { message: Message; showStats: boolean }) {
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
  const showTyping = streaming && !message.content

  return (
    <MessageRow align="start" className="gap-2">
      <MessageAvatar className="mb-6 size-8 bg-transparent">
        <Mascot busy={streaming} className="size-7" />
      </MessageAvatar>
      <MessageContent className="gap-2">
        {tools.length > 0 && (
          <div className="flex w-full max-w-xl flex-col gap-2">
            {tools.map((tool) => (
              <ToolCard key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        )}

        {message.content && (
          <Bubble variant="muted" className="max-w-[min(100%,42rem)]">
            <BubbleContent className="px-4 py-3 text-[15px]">
              <Markdown>{message.content}</Markdown>
            </BubbleContent>
          </Bubble>
        )}

        {showTyping && <TypingBubble status={message.statusText} />}
        {streaming && message.content && message.statusText && (
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

        {message.approval && (
          <div className="w-full max-w-xl">
            <ApprovalCard message={message} />
          </div>
        )}

        {showStats && !streaming && <Stats message={message} />}
      </MessageContent>
    </MessageRow>
  )
}
