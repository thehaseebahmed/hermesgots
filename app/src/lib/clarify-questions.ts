/**
 * The questions of the call a live prompt came out of.
 *
 * Hermes asks a call's questions one prompt at a time (`gateway/session_pending_controls.py`), so a
 * prompt names a single question and nothing else. The set it belongs to is the call the agent made,
 * whose arguments hold every question it put: one row in the transcript, one call in the run. This
 * reads that set back, so a screen can draw the call's questions as one card instead of one at a
 * time.
 */

import { questionAt, questionsIn } from "./clarify.ts"
import type { ClarifyQuestion } from "./db.ts"
import { parseArgs } from "./tool-calls.ts"

/** The part of a transcript row this reads: the calls the row made, with their arguments. */
export interface CalledRow {
  tool_calls?: { function: { name: string; arguments: string } }[] | null
}

/** The questions one call's arguments carry: `{ questions: [...] }`, and nothing else. */
export function questionsOf(argumentsText: string): ClarifyQuestion[] {
  const parsed = parseArgs(argumentsText) as { questions?: unknown } | null
  return questionsIn(parsed?.questions)
}

/**
 * The questions a question belongs to: those of the newest clarify call that put it, walked from the
 * end of the transcript back, so the row of the call being asked about is reached before any older
 * one. Undefined where no call put it — a host old enough to ask without a call row, and a question
 * asked from a prompt alone.
 */
export function questionsAround(
  question: string,
  rows: readonly CalledRow[],
): ClarifyQuestion[] | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    for (const call of rows[index].tool_calls ?? []) {
      if (call.function.name !== "clarify") continue
      const questions = questionsOf(call.function.arguments)
      if (questionAt(questions, question) >= 0) return questions
    }
  }
  return undefined
}
