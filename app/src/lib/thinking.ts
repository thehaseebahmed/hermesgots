/**
 * A reply's thinking, kept in runs: one per contiguous stretch of thinking between tool calls, each
 * anchored to the call that broke it, and drawn as the rows it touches: `thinkingRows` is the one
 * rule for the rows a reply draws — its runs marked where the turn still thinks — and
 * `mergeThoughtRows` is the one rule for when two of them are one. `placeThinking` is the one rule
 * for where those rows stand among a reply's parts, and `statusLineOf` the one rule for the line the
 * live cluster ends on: the thought row, the tool group's row, then the status line (ADR 0070).
 * The rules here are pure and reach nothing, so `scripts/test-thinking.mjs` drives them without a
 * screen; the ingest that fills them in is `chat.ts`, and the thread that draws them is
 * `message-item.tsx`. See ADR 0038, ADR 0049 and ADR 0070.
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
export type ThoughtStretch = Omit<ReasoningRun, "afterToolId"> & { thinking: boolean }

/** A drawn row and the places it covers in the drawn list, which are the segment's own indices. */
export type ThoughtRow = {
  row: ThoughtStretch
  /** Where the row's first stretch was drawn. */
  from: number
  /** Where its last one was, so `from === to` is a stretch nothing merged with. */
  to: number
}

/**
 * The rows a reply's thinking is drawn as, from the stretches a segment placed in order — a `null`
 * standing for anything else drawn at that place (a tool group, a card, text, a block), which is what
 * keeps two rows apart. Consecutive stretches become one row: their words joined as paragraphs, in
 * the order they arrived and none dropped; thinking while any of them still is; and carrying a span
 * only where every one of them has one, since a sum over a stretch nobody watched would claim less
 * time than the thinking took. Two replies' lists never meet, so rows in different replies never
 * merge.
 *
 * Each row also answers which places it covers, so this is the only walk that decides where a group
 * of touching stretches ends: a caller draws a row where `from` was and skips to `to`, rather than
 * scanning the list again to find the same edges.
 */
export function mergeThoughtRows(drawn: readonly (ThoughtStretch | null)[]): ThoughtRow[] {
  const rows: ThoughtRow[] = []
  let from = -1
  const flush = (to: number) => {
    if (from < 0) return
    // One stretch nothing touched is the row it was drawn as: nothing to join, so the object the
    // caller handed over is drawn again rather than rebuilt on every redraw of a common reply.
    rows.push({
      row: from === to ? (drawn[from] as ThoughtStretch) : joined(drawn, from, to),
      from,
      to,
    })
    from = -1
  }
  for (let at = 0; at < drawn.length; at++) {
    if (drawn[at]) {
      if (from < 0) from = at
    } else flush(at - 1)
  }
  flush(drawn.length - 1)
  return rows
}

/** The row a run of touching stretches draws as: their words, their label truth and their span. */
function joined(
  drawn: readonly (ThoughtStretch | null)[],
  from: number,
  to: number,
): ThoughtStretch {
  const group = drawn.slice(from, to + 1).filter((one): one is ThoughtStretch => one !== null)
  const row: ThoughtStretch = {
    text: group.map((one) => one.text).join("\n\n"),
    thinking: group.some((one) => one.thinking),
  }
  if (group.every((one) => typeof one.spanMs === "number"))
    row.spanMs = group.reduce((sum, one) => sum + (one.spanMs ?? 0), 0)
  return row
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

/**
 * One row as the thread draws it: its words, the key it keeps across redraws, and the truth its
 * label reads from. A row is always a run: nothing empty is ever a run (`runsOf` drops it), so a
 * turn whose model has said nothing draws no row at all — the status line says the turn is working
 * until a word of thinking arrives (ADR 0070).
 */
export type RunPart = {
  key: string
  text: string
  /** How long this device watched the stretch think, where it watched all of it. */
  spanMs?: number
  /** The row says the turn is thinking right now, so it turns a loader beside its word. */
  thinking: boolean
  /** The call this stretch follows; absent on the run at the top of a reply, and on a merged row. */
  afterToolId?: string
}

/**
 * The rows a reply's thinking is drawn as, from the runs it already has: the last run still
 * thinking while the reply works, and the run after the model's last call marked where that call
 * left the model quiet. A turn with no word of thinking yet draws no row — not even an empty one
 * behind its last call — so the status line says that first moment, and no row of the cluster ever
 * stands below the tool row it is about (ADR 0070).
 */
export function thinkingRows(message: {
  reasoningRuns?: ReasoningRun[]
  reasoning?: string
  content: string
  status?: string
  /** The host's own word for what the turn is doing while it has one. */
  statusText?: string
  /** An approval or a question is waiting on the reader: the turn waits, it does not think. */
  waiting?: boolean
  tools?: { status?: string; contentOffset?: number; toolCallId: string }[]
}): RunPart[] {
  const runs = runsOf(message)
  const working = message.status === "streaming" && !message.content
  const parts: RunPart[] = runs.map((run, index) => ({
    ...run,
    key: `run-${index}`,
    // A span is stamped exactly when its run ends, so a run carrying one has no words still
    // arriving: the label reads what it measured, wherever the row is drawn.
    thinking: index === runs.length - 1 && working && run.spanMs === undefined,
  }))
  const last = message.tools?.at(-1)
  const running = message.tools?.some((tool) => tool.status === "running")
  const quiet =
    working || (last !== undefined && (last.contentOffset ?? 0) >= message.content.length)
  if (message.status !== "streaming" || running || !quiet || message.waiting || message.statusText)
    return parts
  const live = parts.at(-1)
  if (last && live?.afterToolId === last.toolCallId && live.spanMs === undefined)
    live.thinking = true
  return parts
}

/**
 * A reply's parts as far as the placing rule reads them: a thought row and the two rows that break
 * it — a call's row, which groups the calls it draws, and a card's row, which draws the one call it
 * followed. Anything else drawn at a place (text, media, an interface block) breaks a run of rows
 * by being neither of them.
 */
export type PlacingPart = {
  kind: string
  /** A call's row: the calls it groups. */
  tools?: readonly { toolCallId: string }[]
  /** A card's row: the one call it draws. */
  tool?: { toolCallId: string }
}

/**
 * The word a thinking row says while its words still arrive — the row's own, never one of the status
 * line's rotating ones (ADR 0070). The one home for it, so the row, the tests and the browser flow
 * that read it cannot drift apart.
 */
export const THINKING_WORD = "thinking"

/**
 * Where a reply's thinking rows stand among its parts — the one placing rule, asked by the thread
 * that draws a reply and by the tests that pin the order, so no screen can place them differently
 * (ADR 0070). A run's row goes above the tool row whose call it led into, so the working-out reads
 * over the work it led into; a run at the top of a reply stands above everything; a run whose call
 * this reply doesn't draw follows the last call it does draw, and sits at the top when it draws
 * none. Two stretches after the same part arrive in order, so each is spliced where the part stands
 * by then and the later never stacks above the earlier. A stretch that follows a clarify or an
 * agent card stays behind that card, neither of which is a tool row.
 */
export function placeThinking<P extends PlacingPart>(
  parts: P[],
  runs: readonly RunPart[],
  row: (run: RunPart) => P,
): P[] {
  // Most replies never thought: nothing to place, and nothing to build.
  if (!runs.length) return parts
  const leading = runs.filter((run) => !run.afterToolId)
  const placed: P[] = [...leading.map(row), ...parts]
  const holdsCall = (part: P) =>
    part.kind === "tools" || part.kind === "clarify" || part.kind === "agent"
  const lastCall = placed.findLastIndex(holdsCall)
  const top = leading.length - 1
  const inserted = new Map<number, number>()
  for (const run of runs) {
    const id = run.afterToolId
    if (!id) continue
    const found = placed.findIndex(
      (one) =>
        (one.kind === "tools" && Boolean(one.tools?.some((tool) => tool.toolCallId === id))) ||
        ((one.kind === "clarify" || one.kind === "agent") && one.tool?.toolCallId === id),
    )
    const at = found >= 0 ? found : lastCall >= 0 ? lastCall : top
    const count = inserted.get(at) ?? 0
    // The stretch of a real call goes above its tool row; a card's own stretch stays behind the
    // card, where the reader's eye already is.
    const above = found >= 0 && placed[at].kind === "tools"
    placed.splice(above ? at + count : at + 1 + count, 0, row(run))
    inserted.set(at, count + 1)
  }
  return placed
}

/**
 * Whether a reply draws a status line at all. A reply whose error is shown, or that the host
 * stopped, draws none — its error or "Stopped" stands where the line would — so the count of
 * subagents at work goes to the thread's foot instead of a line that is not there.
 */
export const drawsFootLine = (status?: string) => status !== "error" && status !== "stopped"

/** Whether a message is the reply that draws the count on its own line, and not the thread's foot. */
export const carriesCount = (message: { role?: string; status?: string }) =>
  message.role === "assistant" && drawsFootLine(message.status)

/** What a reply's line is decided from, read off the reply's own row. */
export type ReplyFacts = {
  status?: string
  /** An approval or a question waits on the reader: the turn waits, it does not work. */
  waiting?: boolean
  /** A call of this reply runs, and its own row says so. */
  runningCall?: boolean
  /** A thought row above already says the turn is thinking. */
  thinks?: boolean
  /** What the turn is doing, as the app words it, while it is still working. */
  activity?: string
}

/**
 * A reply's own facts, as the app reads them off its row: whether a prompt holds it, whether a call
 * still runs, whether a thought row above says thinking, and the activity its words come from. The
 * activity is handed in because `format.ts` owns it and this rule reaches nothing.
 */
export function replyFacts(
  message: {
    status?: string
    approval?: { resolved?: unknown }
    clarify?: { resolved?: unknown }
    tools?: { status?: string; contentOffset?: number; toolCallId: string }[]
    reasoningRuns?: ReasoningRun[]
    reasoning?: string
    content: string
    statusText?: string
  },
  activity: string,
): ReplyFacts {
  return {
    status: message.status,
    waiting:
      Boolean(message.approval && !message.approval.resolved) ||
      Boolean(message.clarify && !message.clarify.resolved),
    runningCall: Boolean(message.tools?.some((tool) => tool.status === "running")),
    thinks: thinkingRows(message).some((run) => run.thinking),
    activity,
  }
}

/**
 * The thread's one live row, and what it says (ADR 0076): the catch-up line while the thread's
 * first read is out — it stands where a reply's line would (ADR 0066), so the count of subagents at
 * work is its only words, its loader turning in the blue — and otherwise the last reply's own line,
 * decided by the same rule a screen with no catch-up line uses (`statusLineOf`). Where the thread
 * has no reply to speak for, the count stands alone without a loader, its own row as it always was.
 *
 * One rule for the row means one row: a thread never says the same moment twice, once as its own
 * line and once as the catch-up's.
 */
export function threadLineOf(input: {
  /** Whether the catch-up line stands: the first read is out and the device holds rows. */
  catching: boolean
  /** The catch-up line's words, which `StatusLine` dresses from the catching pool. */
  catchingText: string
  /** How many subagents the session has at work. */
  running: number
  /** The last reply's facts, where the thread has a reply that draws a line at all. */
  reply?: ReplyFacts
}): FootLine | undefined {
  if (input.catching)
    return input.running > 0
      ? { count: "alone", countLoader: true }
      : { text: input.catchingText, count: "none", countLoader: false }
  if (input.reply)
    return statusLineOf({ ...input.reply, count: input.running, countShown: input.running > 0 })
  return input.running > 0 ? { count: "alone", countLoader: false } : undefined
}

/** Where the count of subagents at work sits, once it is the status line's own (ADR 0070). */
export type FootCount = "suffix" | "alone" | "none"

/** The status line a reply's live cluster ends on: its words and where the count rides them. */
export type FootLine = {
  /** The line's words before the count; absent when it says nothing but the count. */
  text?: string
  /** The count at work: riding the words, alone on the line, or not drawn at all. */
  count: FootCount
  /** Whether the count turns its own loader, in the info blue, because it alone keeps the line live. */
  countLoader: boolean
}

/**
 * The status line a reply draws, or none at all — the one rule for what the foot of a reply says
 * (ADR 0070). It says nothing while a thought row above says the turn is thinking, and nothing
 * while a call runs save the count of subagents at work; the wait words take the busy words' place
 * and keep the line live. A reply that failed or was stopped draws no line. The count is the line's
 * own: a suffix on its words while the turn works or waits, and its only words once the turn is
 * done and its subagents still run — turning its loader in the blue only then, when it alone is
 * what the line is for.
 */
export function statusLineOf(input: {
  status?: string
  /** An approval or a question waits on the reader: the line says what the reader must do. */
  waiting?: boolean
  /** A call of this reply runs, and its own row says so. */
  runningCall?: boolean
  /** A thought row above already says the turn is thinking. */
  thinks?: boolean
  /** What the turn is doing, as the app words it, while it is still working. */
  activity?: string
  /** How many subagents are at work, where this reply draws them at all. */
  count?: number
  /** Whether this reply draws the count, rather than leaving it to the thread's foot. */
  countShown?: boolean
}): FootLine | undefined {
  // A broken or stopped reply wears its error or "Stopped" where the line would stand.
  if (!drawsFootLine(input.status)) return undefined
  const working = input.status === "streaming"
  const words =
    working && (input.waiting || !(input.runningCall || input.thinks)) ? input.activity : undefined
  const shown = Boolean(input.countShown) && (input.count ?? 0) > 0
  const count: FootCount = !shown ? "none" : words ? "suffix" : "alone"
  if (!words && count === "none") return undefined
  // The line's loader turns for its words; the count's turns only when the count is all it says.
  return { ...(words ? { text: words } : {}), count, countLoader: count === "alone" && !working }
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
