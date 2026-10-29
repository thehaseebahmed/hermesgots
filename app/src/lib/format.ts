import type { Message } from "@/lib/db"
import { runsOf } from "@/lib/thinking"
import { activityOf } from "@/lib/tools"

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

/** What the chat says while the run waits on a question: its status line and the thread's own. */
export const WAITING_FOR_ANSWER = "Waiting for your answer"

/** The two activity lines the status line dresses in a rotating word (`busy-words.ts`). */
export const THINKING_ACTIVITY = "Thinking…"
export const WRITING_ACTIVITY = "Writing…"
export const CATCHING_ACTIVITY = "Catching up…"

/** One line saying what the bot is doing right now. */
export function describeActivity(message: Message) {
  if (message.clarify && !message.clarify.resolved) return WAITING_FOR_ANSWER
  if (message.approval && !message.approval.resolved) return "Waiting for approval"
  const tool = message.tools?.findLast((t) => t.status === "running")
  if (tool) return `${activityOf(tool)}…`
  if (message.statusText) return message.statusText
  if (runsOf(message).length > 0 && !message.content) return THINKING_ACTIVITY
  // After a tool round the model works out its next step before it writes anything.
  const last = message.tools?.at(-1)
  if (last && (last.contentOffset ?? 0) >= message.content.length) return THINKING_ACTIVITY
  return WRITING_ACTIVITY
}
