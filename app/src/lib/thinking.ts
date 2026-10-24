/**
 * A reply's thinking, kept in runs: one per contiguous stretch of thinking between tool calls, each
 * anchored to the call that broke it, and drawn as the rows it touches: `mergeThoughtRows` is the one
 * rule for when two of them are one. The rules here are pure and reach nothing, so
 * `scripts/test-thinking.mjs` drives them without a screen; the ingest that fills them in is
 * `chat.ts`, and the thread that draws them is `message-item.tsx`. See ADR 0038 and ADR 0049.
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

/**
 * How many replies' spans are kept. A reply keeps a handful of runs, so counting replies rather than
 * entries is what a long session actually needs, and evicting a whole reply at once never leaves a
 * span closing against another run's first delta.
 */
const KEEP_SPANS = 2_000

/** The replies being watched, in the order they started, each with its runs by index. */
const watching = new Map<string, Map<number, Watching>>()

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

/** One stretch of a reply's thinking as a row draws it: its words, and what its label reads from. */
export type ThoughtStretch = { text: string; thinking: boolean; spanMs?: number }

/**
 * The rows a reply's thinking is drawn as, from the stretches a segment placed in order — a `null`
 * standing for anything else drawn at that place (a tool group, a card, text, a block), which is what
 * keeps two rows apart. Consecutive stretches become one row: their words joined as paragraphs, in
 * the order they arrived and none dropped; thinking while any of them still is; and carrying a span
 * only where every one of them has one, since a sum over a stretch nobody watched would claim less
 * time than the thinking took. Two replies' lists never meet, so rows in different replies never
 * merge.
 */
export function mergeThoughtRows(drawn: (ThoughtStretch | null)[]): ThoughtStretch[] {
  const rows: ThoughtStretch[] = []
  let group: ThoughtStretch[] = []
  const flush = () => {
    if (!group.length) return
    const row: ThoughtStretch = {
      text: group.map((one) => one.text).join("\n\n"),
      thinking: group.some((one) => one.thinking),
    }
    if (group.every((one) => typeof one.spanMs === "number"))
      row.spanMs = group.reduce((sum, one) => sum + (one.spanMs ?? 0), 0)
    rows.push(row)
    group = []
  }
  for (const stretch of drawn) {
    if (stretch) group.push(stretch)
    else flush()
  }
  flush()
  return rows
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
    const next = kept.slice()
    next[next.length - 1] = { ...last, text: grown }
    return next
  }
  return [...kept, afterToolId === undefined ? { text } : { text, afterToolId }]
}

/** Whether a run has no words to draw: a blank delta or a block of whitespace is not a run. */
const blank = (run: ReasoningRun) => !/\S/.test(run.text)

/**
 * The runs a stored reply carries. A row from before runs kept its thinking in one string: it folds
 * into a single run at the top, so nothing written earlier has to be migrated to be drawn. A run with
 * no words is dropped here rather than by each reader, so what counts runs and what draws them agree.
 */
export function runsOf(message: {
  reasoningRuns?: ReasoningRun[]
  reasoning?: string
}): ReasoningRun[] {
  const runs = message.reasoningRuns ?? (message.reasoning ? [{ text: message.reasoning }] : [])
  return runs.some(blank) ? runs.filter((run) => !blank(run)) : runs
}

/** A delta or a block of this run arrived: the span starts at the first one and ends at the last. */
export function noteRunThinking(id: string, index: number, at = Date.now()) {
  let runs = watching.get(id)
  if (!runs) {
    if (watching.size >= KEEP_SPANS) {
      const oldest = watching.keys().next().value
      if (oldest !== undefined) watching.delete(oldest)
    }
    runs = new Map()
    watching.set(id, runs)
  }
  const entry = runs.get(index)
  if (entry) {
    if (entry.span === undefined) entry.lastAt = at
    return
  }
  runs.set(index, { firstAt: at, lastAt: at })
}

/**
 * The run's thinking ended — a tool call started, the answer began, or the turn finished. Answers
 * the span once, and never counts the wait after the last delta as thinking.
 */
export function closeRun(id: string, index: number): number | undefined {
  const entry = watching.get(id)?.get(index)
  if (!entry || entry.span !== undefined) return undefined
  entry.span = Math.max(0, entry.lastAt - entry.firstAt)
  return entry.span
}

/** Drops what was measured for a reply whose runs are replaced wholesale and start again. */
export function forgetRuns(id: string) {
  watching.delete(id)
}

/**
 * A transcript's runs, each keeping the span this device measured for the same run — the same words
 * after the same call. The transcript has no timings, so a run whose text moved keeps none rather
 * than wearing a number measured for another stretch. Two runs with no call between them are told
 * apart by their place among the unanchored ones, since nothing else tells them apart.
 */
export function carrySpans(
  runs: ReasoningRun[] | undefined,
  local: ReasoningRun[] | undefined,
): ReasoningRun[] | undefined {
  if (!runs) return undefined
  if (!local?.length) return runs
  const top = local.filter((run) => !run.afterToolId)
  let among = 0
  return runs.map((run) => {
    const kept = run.afterToolId
      ? local.find((one) => one.afterToolId === run.afterToolId && one.text === run.text)
      : top[among++]
    if (!kept || kept.text !== run.text || typeof kept.spanMs !== "number") return run
    return { ...run, spanMs: kept.spanMs }
  })
}
