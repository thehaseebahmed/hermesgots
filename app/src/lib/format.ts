import type { Message } from "@/lib/db"
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

/**
 * A count with its thousands grouped, and nothing shortened: 950, 20,000, 1,234,567. A reply's
 * stats are a record rather than a meter, so a number there is read as itself, and `1.2M` would
 * cost the reader the one thing the row is for.
 */
export function formatCount(value: number) {
  if (!Number.isFinite(value)) return "0"
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
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

/** What the status line says while the run waits on an approval, in the same place as the answer's. */
export const WAITING_FOR_APPROVAL = "Waiting for your approval…"

/** What a send is turned down with while the run is held on a prompt. */
export const WAITING_ON_ANSWER = "The bot is waiting on your answer"

/** How many subagents a session has at work, in words: the **Subagent count**'s own. */
export const subagentCountLabel = (count: number) =>
  `${count} subagent${count === 1 ? "" : "s"} running`

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
  // A turn that has written nothing — its first word, or the next one after a tool round — is still
  // working out what to say, so it is not writing yet.
  if (!message.content) return THINKING_ACTIVITY
  const last = message.tools?.at(-1)
  if (last && (last.contentOffset ?? 0) >= message.content.length) return THINKING_ACTIVITY
  return WRITING_ACTIVITY
}
