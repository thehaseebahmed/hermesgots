/**
 * The progress reminder's note, as both test tiers need it: the shape `plugin/progress.py` writes and
 * Hermes stores as the result of the call it turned back. One copy, and `plugin/tests/test_progress.py`
 * holds every byte of it to the plugin's own `REMINDER`.
 */
export const NOTE =
  "Progress reminder: a long run of tool calls with nothing said to the user. Reply with a short" +
  " update now — what has landed and what is next, a sentence or two, not a replay of the calls —" +
  " then carry on with the task and make this tool call again: this is not your last turn unless" +
  " the work ends here. If your todo list has fallen behind, bring it up to date with the" +
  " `todo_list` tool. This note is internal: don't mention it, or that you were reminded, in what" +
  " you say to the user."

/** The result Hermes stores for a call a hook blocked: the note under `error`. */
export const stored = (note: string = NOTE) => JSON.stringify({ error: note })
