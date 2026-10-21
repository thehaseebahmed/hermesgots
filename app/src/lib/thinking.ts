type Watched = { firstReasoningAt: number; span?: number }

const KEEP_SPANS = 2_000
const watched = new Map<string, Watched>()

export function formatThoughtSpan(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function thinkingLabel({ thinking, spanMs }: { thinking: boolean; spanMs?: number }) {
  if (thinking) return "Thinking…"
  if (typeof spanMs === "number") return `Thought for ${formatThoughtSpan(spanMs)}`
  return "Thought"
}

export function noteThinking(id: string, at = Date.now()) {
  if (watched.has(id)) return
  if (watched.size >= KEEP_SPANS) {
    const oldest = watched.keys().next().value
    if (oldest !== undefined) watched.delete(oldest)
  }
  watched.set(id, { firstReasoningAt: at })
}

export function noteAnswer(id: string, at = Date.now()) {
  const entry = watched.get(id)
  if (!entry || entry.span !== undefined) return
  entry.span = Math.max(0, at - entry.firstReasoningAt)
}

export function thoughtSpan(id: string): number | undefined {
  return watched.get(id)?.span
}
