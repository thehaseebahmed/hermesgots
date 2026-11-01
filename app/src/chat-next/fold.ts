import { splitAttachments, steerWords } from "../lib/attachment-text.ts"
import { isSeamScaffolding, seamDrawnContent } from "../lib/compaction-seam.ts"
import type { MessageStats } from "../lib/db.ts"
import { progressReminderNotes } from "../lib/progress-reminder.ts"

import type { Timing } from "../lib/reply-stats.ts"

/** A transcript row as `GET /api/sessions/{id}/messages` returns it; only what a turn is built from. */
export interface Row {
  id: number
  role: string
  content: string | null
  tool_call_id?: string | null
  finish_reason?: string | null
  display_kind?: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] | null
  /** When the host wrote the row, in Unix seconds. */
  timestamp?: number | null
  /** The model's thinking before the row's words and calls; some providers name it `reasoning_content`. */
  reasoning?: string | null
  reasoning_content?: string | null
}

export interface ToolCall {
  id: string
  name: string
  result?: string
  /** The call's arguments as the transcript holds them; a live call has only its `label`. */
  arguments?: string
  /** What the host says of a call while it runs: the argument it previews, cut short. */
  label?: string
  /** When the call was made and when its result came back, in ms, where the host or the stream said. */
  startedAt?: number
  endedAt?: number
  /** The thinking that came before this call, where it opens a stretch of its own. */
  thought?: string
}

/** A reply in the order the host wrote it: its words, then the run of calls it made, then more words. */
export type Part =
  | { kind: "text"; text: string; thought?: string }
  | { kind: "tools"; calls: ToolCall[] }
  /** The host compacted the conversation here; the rows above are summarised in what follows. */
  | { kind: "compaction"; row?: number; at?: number }
  /** A message the user sent while the reply ran, which the agent read after its calls. */
  | { kind: "steer"; text: string }
  /**
   * A progress reminder's note, drawn only behind *Show progress reminders*: the call it refused never
   * ran, so it stands as a row of its own rather than in the group beside it (ADR 0068).
   */
  | { kind: "reminder"; note: string }

/** A file a message carried, as its marker line names it: never its bytes. */
export interface SentFile {
  name: string
  type: string
  size: number
  image: boolean
  path?: string
  /** A photo the row's own hint named, never a file the user sent: drawn, never carried back. */
  host?: true
}

export interface Turn {
  /** The id of the row that opened the turn, where the transcript has it. */
  row?: number
  user: string
  /** When the request was written, in ms, where the host said. */
  at?: number
  /** What the request carried, read off its marker lines, which are not the user's words. */
  files?: SentFile[]
  /** The host archived this turn's request when it compacted: what is left is the work, from the seam on. */
  carried?: boolean
  /** The request is in rows not read yet: the reply is drawn alone, and the turn is whole once they are. */
  cut?: boolean
  parts: Part[]
  /** A turn this device sent and watches from its start, which is what its stats are measured by. */
  timing?: Timing
  /** What the turn cost, measured as its run ended; only a turn measured so has any. */
  stats?: MessageStats
  /** Thinking a live turn has heard that no word or call has followed yet. */
  pendingThought?: string
  /** The host has written the reply's last row: an assistant row that makes no more calls and says why it stopped. */
  done: boolean
  /** The host gave up on the turn (`failed_turn`) and says so in its own words; it is over. */
  failed?: { text: string; row: number }
  /** A reply the host started when a subagent finished: it answers no message of the user's. */
  wake?: boolean
  /** The children whose results this wake turn carries, as the host names them. */
  delivered: string[]
}

/**
 * A transcript with the rows a compaction archived put back above it. The archive read holds the
 * live rows too, in the conversation's order rather than by id, so only the rows the live read lacks
 * are added, in the order the host gave them.
 */
export function withArchive(live: Row[], archive: Row[]): Row[] {
  const held = new Set(live.map((row) => row.id))
  const at = new Map(live.map((row, index) => [row.id, index]))
  const inArchive = new Map(archive.map((row, index) => [row.id, index]))
  const above: Row[] = []
  const after = new Map<number, Row[]>()
  // A turn's request can be a live row (Hermes writes it again when it compacts mid-turn) while the
  // work it started before the compaction is archived: the archive lists that work right after the
  // request, and the work follows it here rather than ending up under an earlier turn.
  let request: number | undefined
  for (const row of archive) {
    if (held.has(row.id)) {
      request = isRequest(row) ? row.id : undefined
    } else if (request !== undefined) {
      const work = after.get(request)
      if (work) work.push(row)
      else after.set(request, [row])
    } else above.push(row)
  }
  // The live read opens on the compaction's rows, which stand above that request; the archive has
  // them after the work, which is where the compaction happened. The live rows that follow the work
  // in the archive but come before the request in the live read move to just after the work.
  const moved = new Map<number, Row[]>()
  for (const [id, work] of after) {
    const last = inArchive.get(work.at(-1)!.id)!
    const rows: Row[] = []
    for (const row of archive.slice(last + 1)) {
      if (!held.has(row.id) || (at.get(row.id) ?? Infinity) > (at.get(id) ?? -1)) break
      rows.push(row)
    }
    moved.set(
      id,
      rows.map((row) => live[at.get(row.id)!]),
    )
  }
  const gone = new Set([...moved.values()].flat().map((row) => row.id))
  return [
    ...above,
    ...live.flatMap((row) =>
      gone.has(row.id) ? [] : [row, ...(after.get(row.id) ?? []), ...(moved.get(row.id) ?? [])],
    ),
  ]
}

const isScaffold = (row: Row) =>
  row.display_kind === "hidden" ||
  row.display_kind === "model_switch" ||
  row.display_kind === "steer" ||
  RESTATED.test(row.content ?? "") ||
  isSeamScaffolding(row)

const isRequest = (row: Row) =>
  row.role === "user" && !DELIVERY.test(row.content ?? "") && !isScaffold(row)

function pushCall(parts: Part[], call: ToolCall) {
  const last = parts.at(-1)
  if (last?.kind === "tools") last.calls.push(call)
  else parts.push({ kind: "tools", calls: [call] })
}

function pushSeam(parts: Part[], seam: Part) {
  if (parts.at(-1)?.kind !== "compaction") parts.push(seam)
}

/** A turn whose request the host archived: what is drawn from the summary on is the work it carried. */
const carriedTurn = (): Turn => ({
  user: "",
  parts: [],
  done: true,
  carried: true,
  delivered: [],
})

/**
 * The line Hermes opens the active request's restatement with after a compaction. The request it
 * restates is already the turn above it, and what follows is the work carried forward.
 */
const RESTATED = /^\[STILL IN PROGRESS — [^\]]*\]/
/**
 * What Hermes leaves in a carried call's result where it pruned the output to save context: a
 * notice, or a one-line summary of the call (`[terminal] ran ... (2,204 chars result)`).
 */
const PRUNED = /^\[(Old tool output cleared|Duplicate tool output|[a-z_]+\] )/

/** What Hermes writes in place of the user when a background subagent finishes. */
const DELIVERY = /^\[(ASYNC DELEGATION|IMPORTANT: \d+ background process)/
const CHILD = /^\[ASYNC DELEGATION COMPLETE — (\S+?)\]/

/**
 * Cuts a transcript at each user row and folds the rows after it into that turn's ordered parts. A
 * delivery row is not the user's: it starts a wake turn, which the rows after it, up to the next
 * reply, belong to. The match is on the text, since Hermes marks the user's own first row with the
 * same `display_kind` it gives a notification. With `partial` the rows are the newest ones of a
 * transcript whose older rows are not read yet, so a reply before the first request is a turn whose
 * request is missing (`cut`) rather than a stray to drop.
 */
const msOf = (row: Row) => (typeof row.timestamp === "number" ? row.timestamp * 1000 : undefined)

export function foldTurns(rows: Row[], partial = false, showReminders = false): Turn[] {
  const turns: Turn[] = []
  const callOf = new Map<string, ToolCall>()
  const refusals = progressReminderNotes(rows)
  // The refused calls already accounted for: a carried copy of a row must not draw its reminder twice.
  const noted = new Set<string>()
  /** The rows just read are a compaction, or the carried copy of work already drawn: the next reply may be the copy of one too. */
  let seamed = false
  /**
   * The divider a compaction left, waiting for the work it carried to be drawn above it. Hermes writes
   * the summary where the boundary is and re-emits the work above it afterwards under the times it had,
   * so the row after the summary is not the row written after the compaction.
   */
  let pending: Extract<Part, { kind: "compaction" }> | undefined
  const openSeam = () => {
    if (!pending) return
    const seam = pending
    pending = undefined
    let last = turns.at(-1)
    if (!last) turns.push((last = carriedTurn()))
    pushSeam(last.parts, seam)
  }
  const writtenAfter = (row: Row) => {
    if (pending?.at === undefined) return true
    const at = msOf(row)
    return at === undefined || at > pending.at
  }
  for (const row of rows) {
    // What the host wrote after the compaction closes the reply above it.
    if (pending && !isScaffold(row) && writtenAfter(row)) openSeam()
    if (row.role === "user") {
      // A steer is the user's, but it goes on the reply it steered rather than opening a turn.
      if (row.display_kind === "steer") {
        turns.at(-1)?.parts.push({ kind: "steer", text: steerWords(row.content ?? "") })
        continue
      }
      if (row.display_kind === "hidden") {
        seamed = true
        const at = msOf(row)
        openSeam()
        pending = { kind: "compaction", row: row.id, ...(at !== undefined ? { at } : {}) }
        continue
      }
      // A model switch, a restatement, the task snapshot and the pruned-skills notice are the model's
      // input: the host stores no flag for them, so they are matched by kind and by their words.
      if (isScaffold(row)) continue
      const content = seamDrawnContent(row)
      if (DELIVERY.test(content)) {
        const last = turns.at(-1)
        const wake =
          last?.wake && !last.done && last.parts.length === 0
            ? last
            : turns[turns.push({ user: "", parts: [], done: false, wake: true, delivered: [] }) - 1]
        const child = CHILD.exec(content)?.[1]
        if (child) wake.delivered.push(child)
        continue
      }
      const { text, attachments } = splitAttachments(content)
      const at = msOf(row)
      turns.push({
        row: row.id,
        user: text,
        ...(at !== undefined ? { at } : {}),
        ...(attachments.length
          ? {
              files: attachments.map(({ name, type, size, image, path, host }) => ({
                name,
                type,
                size,
                image: Boolean(image),
                ...(path ? { path } : {}),
                ...(host ? { host } : {}),
              })),
            }
          : {}),
        parts: [],
        done: false,
        delivered: [],
      })
      continue
    }
    // Rows read newest first can open on a reply whose request is older still: it is drawn alone. A
    // reply the host carried across a compaction opens the turn its archived request left.
    const turn =
      turns.at(-1) ??
      (row.role === "assistant" && (partial || pending)
        ? turns[
            turns.push(
              pending
                ? { user: "", parts: [], done: false, carried: true, delivered: [] }
                : { user: "", parts: [], done: false, cut: true, delivered: [] },
            ) - 1
          ]
        : undefined)
    if (!turn) continue
    if (row.role === "tool") {
      const call = row.tool_call_id ? callOf.get(row.tool_call_id) : undefined
      // A carried copy of a call can hold the cleared notice where the original kept its output.
      if (call && !(call.result && PRUNED.test(row.content ?? ""))) {
        call.result = row.content ?? ""
        const at = msOf(row)
        if (at !== undefined) call.endedAt = at
      }
      continue
    }
    if (row.role !== "assistant") continue
    // A failed turn ends in a row of its own, with no finish reason: it is over, not still writing.
    if (row.display_kind === "failed_turn") {
      turn.done = true
      turn.failed = { text: row.content || "Hermes couldn't finish this reply.", row: row.id }
      continue
    }
    // After a compaction Hermes writes the work it carried forward again, under the ids it had: a
    // call already drawn is that call, and the first reply back is the one already given.
    const asked = row.tool_calls ?? []
    const drawn = asked.filter((one) => !refusals.has(one.id))
    const first = seamed
    seamed = false
    if (asked.length && asked.every((one) => callOf.has(one.id) || noted.has(one.id))) {
      seamed = true
      continue
    }
    if (first && !asked.length && row.content && repeatsEarlier(turns, row.content)) {
      seamed = true
      continue
    }
    turn.done = !asked.length && Boolean(row.finish_reason)
    // The row's thinking goes before whatever the row says or does first, so it follows the call
    // before it and is read with the words or the call it led to.
    let thought = row.reasoning ?? row.reasoning_content ?? undefined
    if (row.content || (thought && !drawn.length)) {
      turn.parts.push({ kind: "text", text: row.content ?? "", ...(thought ? { thought } : {}) })
      thought = undefined
    }
    for (const one of asked) {
      const note = refusals.get(one.id)
      if (note !== undefined) {
        if (showReminders) {
          noted.add(one.id)
          turn.parts.push({ kind: "reminder", note })
        }
        continue
      }
      const call: ToolCall = {
        id: one.id,
        name: one.function.name,
        arguments: one.function.arguments,
        ...(msOf(row) !== undefined ? { startedAt: msOf(row) } : {}),
        ...(thought ? { thought } : {}),
      }
      thought = undefined
      callOf.set(call.id, call)
      pushCall(turn.parts, call)
    }
  }
  // A compaction the host has written nothing after yet closes the turn it fell in.
  openSeam()
  // Only the last turn can still be running. A copy Hermes carried across a compaction has lost the
  // reason its reply stopped, so an earlier turn is finished by what follows it.
  for (const turn of turns.slice(0, -1)) turn.done = true
  return withoutRepeatedFailures(turns)
}

/** Where in a reply a part the stream never carries stood: the calls drawn above it and its words. */
interface Anchor {
  text: number
  calls: number
  part: Part
}

/**
 * What the transcript's copy of a turn holds that its stream cannot: the compactions it folded, and
 * the steers the user sent it (a stream carries an event for neither).
 */
function carriedOf(copy: Turn, live: Turn): Anchor[] {
  // A steer this device sent is already drawn at the point it was sent, and the copy's row for it is
  // the same fact: the two pair off, so a steer lands once whichever of them the thread is drawing.
  const own = live.parts.flatMap((part) => (part.kind === "steer" ? [part.text] : []))
  const anchors: Anchor[] = []
  let text = 0
  let calls = 0
  for (const part of copy.parts) {
    if (part.kind === "compaction") anchors.push({ text, calls, part })
    else if (part.kind === "steer") {
      const at = own.indexOf(part.text)
      if (at >= 0) own.splice(at, 1)
      else anchors.push({ text, calls, part })
    } else if (part.kind === "tools") calls += part.calls.length
    else if (part.kind === "text") text += part.text.length
  }
  return anchors
}

/**
 * A live turn as the transcript's copy of it draws: what the run wrote and no stream event carries —
 * the compactions it folded, the steers the user sent it — comes in at the point the copy says it
 * stood. A steer's row is written when the run read it, which can be well before the read that
 * brings it here, so one whose anchor the reply has already written past goes at the foot of the
 * reply instead of being dropped: the reader sees the steer as soon as the host has it, however far
 * the reply has run on.
 */
export function withCarried(live: Turn, copy: Turn): Turn {
  const carried = carriedOf(copy, live)
  if (!carried.length) return live
  const parts: Part[] = []
  let next = 0
  let text = 0
  let calls = 0
  const put = (part: Part) =>
    part.kind === "compaction" ? pushSeam(parts, part) : parts.push(part)
  const open = () => {
    while (next < carried.length && carried[next].text <= text && carried[next].calls <= calls)
      put(carried[next++].part)
  }
  open()
  for (const part of live.parts) {
    if (part.kind === "text") {
      parts.push(part)
      text += part.text.length
      open()
      continue
    }
    if (part.kind !== "tools") {
      parts.push(part)
      continue
    }
    open()
    const from = calls
    const to = from + part.calls.length
    const splits = carried
      .slice(next)
      .some((one) => one.calls > from && one.calls < to && one.text <= text)
    if (!splits) {
      parts.push(part)
      calls = to
      open()
      continue
    }
    for (const call of part.calls) {
      open()
      pushCall(parts, call)
      calls += 1
    }
  }
  open()
  while (next < carried.length) {
    if (carried[next].part.kind === "steer") parts.push(carried[next].part)
    next += 1
  }
  return { ...live, parts }
}

/**
 * A steer the user just sent, standing in the reply where they sent it. It is drawn at once rather
 * than waiting for the transcript's row, which the host writes when the run reads the steer — after
 * its next tool result, or at the turn's end. `withCarried` pairs the row off against this part, so
 * the two never draw twice.
 */
export function withSteer(live: Turn, text: string): Turn {
  const said = text.trim()
  return said ? { ...live, parts: [...live.parts, { kind: "steer", text: said }] } : live
}

const sameRequest = (a: Turn, b: Turn) =>
  a.user === b.user &&
  (a.files ?? []).map((f) => f.name).join() === (b.files ?? []).map((f) => f.name).join()

/**
 * The turns without a failed one the next turn asks again: the user sent the message once more, so
 * the failure is behind them and the thread reads as if only the second send happened. A failed turn
 * nothing repeats stays, with the host's words.
 */
export function withoutRepeatedFailures(turns: Turn[]): Turn[] {
  const next = (at: number) => turns[at + 1]
  return turns.some(
    (turn, at) => turn.failed && next(at) && !next(at).wake && sameRequest(turn, next(at)),
  )
    ? turns.filter(
        (turn, at) => !(turn.failed && next(at) && !next(at).wake && sameRequest(turn, next(at))),
      )
    : turns
}

/** Whether a reply already drawn ended on these very words. */
function repeatsEarlier(turns: Turn[], text: string): boolean {
  return turns.some((turn) => {
    const last = turn.parts.findLast((part) => part.kind === "text")
    return last?.kind === "text" && last.text === text
  })
}
