/**
 * The progress reminder's own refusal, read out of a transcript (`plugin/progress.py`): Hermes stores
 * the note Gots writes to the model as the result of the call it turned back, so a thread that drew
 * that call would show the machinery instead of the work. Only this hook's refusals carry the note's
 * opening — any other hook's block is a thing the reader should see.
 */
import { readEnvelope } from "./json-envelope.ts"

/** The opening `progress.py` writes and `test-progress-reminder.mjs` holds both sides to. */
export const PROGRESS_REMINDER_HEADER = "Progress reminder:"

/**
 * The note a refusal carries, exactly as the host wrote it (its opening first), or nothing where the
 * result is some other call's. One reading of the envelope, so the recognition, the note the
 * developer view opens and the ids a fold drops are never three answers to one row.
 */
export function progressReminderNote(content: unknown): string | undefined {
  if (typeof content !== "string" || !content.includes(PROGRESS_REMINDER_HEADER)) return undefined
  const note = readEnvelope(content)?.fields.error
  if (typeof note !== "string" || !note.trim().startsWith(PROGRESS_REMINDER_HEADER))
    return undefined
  return note
}

/** Whether a call's result is the reminder's note: the `{"error": …}` Hermes writes for a block. */
export function isProgressReminder(content: unknown): boolean {
  return progressReminderNote(content) !== undefined
}

/**
 * Whether this device draws a reminder as a row of its own: *Show progress reminders*, which only
 * exists behind Developer. One spelling of the pair, because the fold, the live stream, both chat
 * screens and the renderer all have to agree on it (ADR 0068).
 */
export function progressRemindersShown(
  settings: { developer?: boolean; showProgressReminders?: boolean } | null | undefined,
): boolean {
  return Boolean(settings?.developer && settings.showProgressReminders)
}

interface ResultRow {
  role: string
  content?: string | null
  tool_call_id?: string | null
}

/** The note behind each call a reminder refused, by the call's id, in the order the rows gave them. */
export function progressReminderNotes(rows: readonly ResultRow[]): Map<string, string> {
  const notes = new Map<string, string>()
  for (const row of rows) {
    if (row.role !== "tool" || !row.tool_call_id) continue
    const note = progressReminderNote(row.content)
    if (note !== undefined) notes.set(row.tool_call_id, note)
  }
  return notes
}
