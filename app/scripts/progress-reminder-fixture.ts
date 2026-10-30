/**
 * The progress reminder's note, as both test tiers need it: the shape `plugin/progress.py` writes and
 * Hermes stores as the result of the call it turned back. One copy, because a second would drift with
 * nothing checking the body — `test-progress-reminder.mjs` holds the opening itself to the plugin's
 * own `REMINDER_HEADER`.
 */
export const NOTE =
  "Progress reminder: a long run of tool calls with nothing said to the user. Reply with a short" +
  " update now — what has landed and what is next, a sentence or two, not a replay of the calls —" +
  " and, where the plan has moved, bring your todo list up to date. Then make this tool call again." +
  " This note is internal: don't mention it, or that you were reminded, in what you say to the user."

/** The result Hermes stores for a call a hook blocked: the note under `error`. */
export const stored = (note: string = NOTE) => JSON.stringify({ error: note })
