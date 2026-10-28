/** A transcript row as `GET /api/sessions/{id}/messages` returns it; only what a turn is built from. */
export interface Row {
  id: number
  role: string
  content: string | null
  tool_call_id?: string | null
  finish_reason?: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] | null
}

export interface ToolCall {
  id: string
  name: string
  result?: string
}

/** A reply in the order the host wrote it: its words, then the run of calls it made, then more words. */
export type Part = { kind: "text"; text: string } | { kind: "tools"; calls: ToolCall[] }

export interface Turn {
  user: string
  parts: Part[]
  /** The host has written the reply's last row: an assistant row that makes no more calls and says why it stopped. */
  done: boolean
}

/** Cuts a transcript at each user row and folds the rows after it into that turn's ordered parts. */
export function foldTurns(rows: Row[]): Turn[] {
  const turns: Turn[] = []
  const callOf = new Map<string, ToolCall>()
  for (const row of rows) {
    if (row.role === "user") {
      turns.push({ user: row.content ?? "", parts: [], done: false })
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
      const call: ToolCall = { id: asked.id, name: asked.function.name }
      callOf.set(call.id, call)
      const last = turn.parts.at(-1)
      if (last?.kind === "tools") last.calls.push(call)
      else turn.parts.push({ kind: "tools", calls: [call] })
    }
  }
  return turns
}
