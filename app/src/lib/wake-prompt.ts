/**
 * The wake run, read out of a transcript: the plugin's `POST /v1/runs` when a delegated subagent
 * finishes lands as an ordinary `user` row whose line 1 names that subagent, and its body is the
 * notification the model reads. The thread must draw nothing of it — it is the model's input, never
 * the user's message — while the turn it opens still folds as a turn of its own. Pure over the rows
 * alone, so a synced, reloaded or imported chat folds it the same way.
 */
import type { SessionMessage } from "./hermes.ts"

/**
 * Line 1 of the wake prompt, pinned by the plugin (the app folds on it, so one shape is guaranteed):
 * `[ASYNC DELEGATION COMPLETE — <child session id>]`, em dash and all.
 */
export const WAKE_PROMPT_HEADER = "[ASYNC DELEGATION COMPLETE — "

/** Whether a row's first line is the pinned header, closed with the child id's bracket. */
function opensWithHeader(content: string) {
  const [first = ""] = content.split(/\r?\n/, 1)
  const line = first.trimEnd()
  return line.startsWith(WAKE_PROMPT_HEADER) && line.endsWith("]")
}

/**
 * Whether `row` is the wake run's own input. A delivery carries the same header and is the bot's
 * message (checked first, wherever this is asked), so only a row with no display kind at all — the
 * plugin posts none — can be the prompt, and only a `user` row is one.
 */
export const isWakePrompt = (row: Pick<SessionMessage, "role" | "content" | "display_kind">) =>
  row.role === "user" &&
  !row.display_kind &&
  typeof row.content === "string" &&
  opensWithHeader(row.content)
