import type { Message } from "@/lib/db"

export function formatDuration(ms: number) {
  if (ms < 60_000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** Compact token counts: 950, 12.3k, 339k, 1M. */
export function formatTokens(tokens: number) {
  const compact = (value: number, unit: string) =>
    `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}${unit}`
  if (tokens >= 1_000_000) return compact(tokens / 1_000_000, "M")
  if (tokens >= 1_000) return compact(tokens / 1_000, "k")
  return String(tokens)
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" })

/** "in 5 min", "3 hr. ago", "yesterday". */
export function formatRelative(timestamp: number, now: number) {
  const seconds = Math.round((timestamp - now) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ]
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return relative.format(seconds, "second")
}

/** One line saying what the bot is doing right now. */
export function describeActivity(message: Message) {
  if (message.clarify && !message.clarify.resolved) return "Waiting for your answer"
  if (message.approval && !message.approval.resolved) return "Waiting for approval"
  const tool = message.tools?.findLast((t) => t.status === "running")
  if (tool) return `${tool.emoji ? `${tool.emoji} ` : ""}${tool.label}…`
  if (message.statusText) return message.statusText
  if (message.reasoning && !message.content) return "Thinking…"
  return "Writing…"
}
