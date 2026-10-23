/**
 * A reply's thinking, kept in runs: one per contiguous stretch of thinking between tool calls, each
 * anchored to the call that broke it. The rules here are pure and reach nothing, so
 * `scripts/test-thinking.mjs` drives them without a screen; the ingest that fills them in is
 * `chat.ts`, and the thread that draws them is `message-item.tsx`. See ADR 0039.
 */

/** One stretch of a reply's thinking, and the tool call it followed. */
export type ReasoningRun = {
  text: string
  /** The call this run's thinking follows; undefined for the run at the top of a reply. */
  afterToolId?: string
  /** How long this device watched the run think, in ms. Kept on the reply's row, never synced. */
  spanMs?: number
}

/** A run being watched: its first delta and its last, so its span is the thinking and nothing else. */
type Watching = { firstAt: number; lastAt: number; span?: number }

const KEEP_SPANS = 2_000
const watching = new Map<string, Watching>()

const watchedKey = (id: string, index: number) => `${id}\u0000${index}`

export function formatThoughtSpan(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function thinkingLabel({ thinking, spanMs }: { thinking: boolean; spanMs?: number }) {
  if (thinking) return "Thinking…"
  if (typeof spanMs === "number") return `Thought for ${formatThoughtSpan(spanMs)}`
  return "Thought it through"
}

/**
 * Adds a piece of thinking to a reply's runs: the piece grows the last run when it continues the
 * same stretch (`afterToolId` is the same call), and opens a new run after a tool call. A whole
 * block is a paragraph of its own; a delta joins on. Nothing empty ever becomes a run, and the array
 * given is never touched, so a row already flushed can't be rewritten under it.
 */
export function appendThinking(
  runs: ReasoningRun[] | undefined,
  afterToolId: string | undefined,
  text: string,
  wholeBlock: boolean,
): ReasoningRun[] {
  const kept = runs ?? []
  if (!text) return kept
  const last = kept.at(-1)
  if (last && last.afterToolId === afterToolId) {
    const grown = wholeBlock ? `${last.text}\n\n${text}` : last.text + text
    return [...kept.slice(0, -1), { ...last, text: grown }]
  }
  return [...kept, afterToolId === undefined ? { text } : { text, afterToolId }]
}

/**
 * The runs a stored reply carries. A row from before runs kept its thinking in one string: it folds
 * into a single run at the top, so nothing written earlier has to be migrated to be drawn.
 */
export function runsOf(message: {
  reasoningRuns?: ReasoningRun[]
  reasoning?: string
}): ReasoningRun[] {
  if (message.reasoningRuns) return message.reasoningRuns
  return message.reasoning ? [{ text: message.reasoning }] : []
}

/** A delta or a block of this run arrived: the span starts at the first one and ends at the last. */
export function noteRunThinking(id: string, index: number, at = Date.now()) {
  const key = watchedKey(id, index)
  const entry = watching.get(key)
  if (entry) {
    if (entry.span === undefined) entry.lastAt = at
    return
  }
  if (watching.size >= KEEP_SPANS) {
    const oldest = watching.keys().next().value
    if (oldest !== undefined) watching.delete(oldest)
  }
  watching.set(key, { firstAt: at, lastAt: at })
}

/**
 * The run's thinking ended — a tool call started, the answer began, or the turn finished. Answers
 * the span once, and never counts the wait after the last delta as thinking.
 */
export function closeRun(id: string, index: number): number | undefined {
  const entry = watching.get(watchedKey(id, index))
  if (!entry || entry.span !== undefined) return undefined
  entry.span = Math.max(0, entry.lastAt - entry.firstAt)
  return entry.span
}

/** Drops what was measured for a reply whose runs are replaced wholesale and start again. */
export function forgetRuns(id: string) {
  const prefix = `${id}\u0000`
  for (const key of [...watching.keys()]) if (key.startsWith(prefix)) watching.delete(key)
}

/**
 * A transcript's runs, each keeping the span this device measured for the same run in the same place
 * — the same text at the same index. The transcript has no timings, so a run whose text moved keeps
 * none rather than wearing a number measured for another stretch.
 */
export function carrySpans(
  runs: ReasoningRun[] | undefined,
  local: ReasoningRun[] | undefined,
): ReasoningRun[] | undefined {
  if (!runs) return undefined
  return runs.map((run, index) => {
    const kept = local?.[index]
    if (!kept || kept.text !== run.text || typeof kept.spanMs !== "number") return run
    return { ...run, spanMs: kept.spanMs }
  })
}
