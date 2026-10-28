/** A transcript row as `GET /api/sessions/{id}/messages` returns it; only what a turn is built from. */
export interface Row {
  id: number
  role: string
  content: string | null
  tool_call_id?: string | null
  finish_reason?: string | null
  display_kind?: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] | null
}

export interface ToolCall {
  id: string
  name: string
  result?: string
  /** The call's arguments as the transcript holds them; a live call has only its `label`. */
  arguments?: string
  /** What the host says of a call while it runs: the argument it previews, cut short. */
  label?: string
}

/** A reply in the order the host wrote it: its words, then the run of calls it made, then more words. */
export type Part =
  | { kind: "text"; text: string }
  | { kind: "tools"; calls: ToolCall[] }
  /** The host compacted the conversation here; the rows above are summarised in what follows. */
  | { kind: "compaction" }

export interface Turn {
  user: string
  /** The host archived this turn's request when it compacted: what is left is the work, from the seam on. */
  carried?: boolean
  parts: Part[]
  /** The host has written the reply's last row: an assistant row that makes no more calls and says why it stopped. */
  done: boolean
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
  return [...archive.filter((row) => !held.has(row.id)), ...live]
}

/** What Hermes writes in place of the user when a background subagent finishes. */
const DELIVERY = /^\[ASYNC DELEGATION/
const CHILD = /^\[ASYNC DELEGATION COMPLETE — (\S+?)\]/

/**
 * Cuts a transcript at each user row and folds the rows after it into that turn's ordered parts. A
 * delivery row is not the user's: it starts a wake turn, which the rows after it, up to the next
 * reply, belong to. The match is on the text, since Hermes marks the user's own first row with the
 * same `display_kind` it gives a notification.
 */
export function foldTurns(rows: Row[]): Turn[] {
  const turns: Turn[] = []
  const callOf = new Map<string, ToolCall>()
  for (const row of rows) {
    if (row.role === "user") {
      // The host's own rows are the model's input, never the user's words. A compaction leaves one,
      // empty, where the summary went; a model switch is a note to the model.
      if (row.display_kind === "model_switch") continue
      if (row.display_kind === "hidden") {
        const last = turns.at(-1)
        if (!last)
          turns.push({
            user: "",
            parts: [{ kind: "compaction" }],
            done: true,
            carried: true,
            delivered: [],
          })
        else if (last.parts.at(-1)?.kind !== "compaction") last.parts.push({ kind: "compaction" })
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
      turns.push({ user: content, parts: [], done: false, delivered: [] })
      continue
    }
    const turn = turns.at(-1)
    if (!turn) continue
    if (row.role === "tool") {
      const call = row.tool_call_id ? callOf.get(row.tool_call_id) : undefined
      if (call) call.result = row.content ?? ""
      continue
    }
    if (row.role !== "assistant") continue
    turn.done = !row.tool_calls?.length && Boolean(row.finish_reason)
    if (row.content) turn.parts.push({ kind: "text", text: row.content })
    for (const asked of row.tool_calls ?? []) {
      const call: ToolCall = {
        id: asked.id,
        name: asked.function.name,
        arguments: asked.function.arguments,
      }
      callOf.set(call.id, call)
      const last = turn.parts.at(-1)
      if (last?.kind === "tools") last.calls.push(call)
      else turn.parts.push({ kind: "tools", calls: [call] })
    }
  }
  return turns
}
