import { splitAttachments } from "../lib/attachment-text.ts"
import type { MessageStats } from "../lib/db.ts"
import { steerText } from "../lib/steer.ts"

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

/** A file a message carried, as its marker line names it: never its bytes. */
export interface SentFile {
  name: string
  type: string
  size: number
  image: boolean
  path?: string
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
  failed?: string
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

const isRequest = (row: Row) =>
  row.role === "user" &&
  row.display_kind !== "hidden" &&
  row.display_kind !== "steer" &&
  row.display_kind !== "model_switch" &&
  !DELIVERY.test(row.content ?? "") &&
  !RESTATED.test(row.content ?? "")

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
 * same `display_kind` it gives a notification.
 */
const msOf = (row: Row) => (typeof row.timestamp === "number" ? row.timestamp * 1000 : undefined)

export function foldTurns(rows: Row[]): Turn[] {
  const turns: Turn[] = []
  const callOf = new Map<string, ToolCall>()
  /** The rows just read are a compaction, or the carried copy of work already drawn: the next reply may be the copy of one too. */
  let seamed = false
  for (const row of rows) {
    if (row.role === "user") {
      // The host's own rows are the model's input, never the user's words. A compaction leaves one,
      // empty, where the summary went; a model switch is a note to the model.
      if (row.display_kind === "model_switch") continue
      // A steer is the user's, but it goes on the reply it steered rather than opening a turn.
      if (row.display_kind === "steer") {
        turns.at(-1)?.parts.push({ kind: "steer", text: steerText(row.content ?? "") })
        continue
      }
      if (RESTATED.test(row.content ?? "")) continue
      if (row.display_kind === "hidden") {
        seamed = true
        const last = turns.at(-1)
        const at = msOf(row)
        const seam = {
          kind: "compaction" as const,
          row: row.id,
          ...(at !== undefined ? { at } : {}),
        }
        if (!last)
          turns.push({
            user: "",
            parts: [seam],
            done: true,
            carried: true,
            delivered: [],
          })
        else if (last.parts.at(-1)?.kind !== "compaction") last.parts.push(seam)
        continue
      }
      const content = row.content ?? ""
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
              files: attachments.map(({ name, type, size, image, path }) => ({
                name,
                type,
                size,
                image: Boolean(image),
                ...(path ? { path } : {}),
              })),
            }
          : {}),
        parts: [],
        done: false,
        delivered: [],
      })
      continue
    }
    const turn = turns.at(-1)
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
      turn.failed = row.content || "Hermes couldn't finish this reply."
      continue
    }
    // After a compaction Hermes writes the work it carried forward again, under the ids it had: a
    // call already drawn is that call, and the first reply back is the one already given.
    const asked = row.tool_calls ?? []
    const first = seamed
    seamed = false
    if (asked.length && asked.every((one) => callOf.has(one.id))) {
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
    if (row.content || (thought && !asked.length)) {
      turn.parts.push({ kind: "text", text: row.content ?? "", ...(thought ? { thought } : {}) })
      thought = undefined
    }
    for (const one of asked) {
      const call: ToolCall = {
        id: one.id,
        name: one.function.name,
        arguments: one.function.arguments,
        ...(msOf(row) !== undefined ? { startedAt: msOf(row) } : {}),
        ...(thought ? { thought } : {}),
      }
      thought = undefined
      callOf.set(call.id, call)
      const last = turn.parts.at(-1)
      if (last?.kind === "tools") last.calls.push(call)
      else turn.parts.push({ kind: "tools", calls: [call] })
    }
  }
  // Only the last turn can still be running. A copy Hermes carried across a compaction has lost the
  // reason its reply stopped, so an earlier turn is finished by what follows it.
  for (const turn of turns.slice(0, -1)) turn.done = true
  return turns
}

/** Whether a reply already drawn ended on these very words. */
function repeatsEarlier(turns: Turn[], text: string): boolean {
  return turns.some((turn) => {
    const last = turn.parts.findLast((part) => part.kind === "text")
    return last?.kind === "text" && last.text === text
  })
}
