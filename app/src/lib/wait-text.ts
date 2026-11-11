/**
 * What a wait says, in the app's words: one sentence for a question, an approval, a plan the host has
 * ready, or a run that stalled with its reason.
 *
 * It is a module of its own because two screens ask the same question of two places. Code's row reads
 * the reason its bot's server reports, through `waiting.ts` — which polls, and so pulls React and the
 * device database with it — while a bot's chat row reads the question or the approval its own reply
 * carries. That second reader is a pure rule a unit test runs with no DOM, no database and no React, so
 * the sentence cannot live behind the poll, and a second copy of it would drift from this one.
 */
import type { WaitingReason } from "./hermes.ts"

/** A wait's one sentence, as every list that draws a waiting row says it. */
export function reasonText(reason: WaitingReason) {
  if (reason.kind === "question")
    return reason.count > 1 ? `${reason.count} questions to answer` : "Awaiting your answer"
  if (reason.kind === "approval") {
    const command = reason.command?.split("\n")[0].trim()
    return command ? `Approve ${command}` : "Needs approval to run a command"
  }
  if (reason.kind === "stalled") return reason.reason
  if (reason.kind === "plan") return "Plan ready for review"
  // A kind this build doesn't know yet still means the session wants the user, not a plan.
  return "Needs you"
}
