/**
 * The progress reminder's own refusal, read out of a transcript (`progress.py`, ADR 0068): the note
 * Gots writes to the model, which Hermes stores as the result of the call it turned back. The thread
 * must draw nothing of that call — the note is the host talking to the model, never to the reader,
 * and the call never ran — while the call the model makes again a moment later is the work the user
 * waited on.
 *
 * The note's opening is pinned by the plugin (the app matches on it, so one shape is guaranteed),
 * and only this hook's refusals carry it: any other hook's block is a thing the reader should see.
 */
export const PROGRESS_REMINDER_HEADER = "Progress reminder:"

/** What a refused call's result parses to, where it is the JSON Hermes stores a hook's block as. */
function storedError(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object") return undefined
    const note = (parsed as { error?: unknown }).error
    return typeof note === "string" ? note : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a call's result is the progress reminder's note. Read from either shape: the JSON envelope
 * a transcript holds, or the note itself, which is what a stream's preview may carry.
 */
export function isProgressReminder(content: unknown): boolean {
  if (typeof content !== "string") return false
  const value = content.trim()
  if (!value) return false
  const note = value.startsWith("{") ? storedError(value) : value
  return note?.trim().startsWith(PROGRESS_REMINDER_HEADER) ?? false
}

/** What a fold needs of a row to find a refusal: the tool row, and the call it answers. */
interface ResultRow {
  role: string
  content?: string | null
  tool_call_id?: string | null
}

/**
 * The call ids this transcript refused with a progress reminder. A call is drawn from the assistant
 * row that names it, and its result comes after it, so the ids are read in one pass and the fold
 * then asks, per call, whether it is one of them.
 */
export function refusedCallIds(rows: readonly ResultRow[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows)
    if (row.role === "tool" && row.tool_call_id && isProgressReminder(row.content))
      ids.add(row.tool_call_id)
  return ids
}
