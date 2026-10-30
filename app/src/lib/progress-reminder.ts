/**
 * The progress reminder's own refusal, read out of a transcript (`plugin/progress.py`): Hermes stores
 * the note Gots writes to the model as the result of the call it turned back, so a thread that drew
 * that call would show the machinery instead of the work. Only this hook's refusals carry the note's
 * opening — any other hook's block is a thing the reader should see.
 */
import { readEnvelope } from "./json-envelope.ts"

/** The opening `progress.py` writes and `test-progress-reminder.mjs` holds both sides to. */
export const PROGRESS_REMINDER_HEADER = "Progress reminder:"

/** Whether a call's result is the reminder's note: the `{"error": …}` Hermes writes for a block. */
export function isProgressReminder(content: unknown): boolean {
  if (typeof content !== "string" || !content.includes(PROGRESS_REMINDER_HEADER)) return false
  const note = readEnvelope(content)?.fields.error
  return typeof note === "string" && note.trim().startsWith(PROGRESS_REMINDER_HEADER)
}

interface ResultRow {
  role: string
  content?: string | null
  tool_call_id?: string | null
}

export function refusedCallIds(rows: readonly ResultRow[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows)
    if (row.role === "tool" && row.tool_call_id && isProgressReminder(row.content))
      ids.add(row.tool_call_id)
  return ids
}
