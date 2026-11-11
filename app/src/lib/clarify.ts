/**
 * Hermes's `clarify` tool result, both ways: the one the app writes when the user answers, and the
 * reading of a result the host wrote. One home, so a card, the transcript's own row and the plain
 * view every screen draws can never disagree about the shape.
 */

import type { ClarifyQuestion } from "@/lib/db"

/** One question and the answer it was given, as the app writes them. */
export interface ClarifyResponse {
  question: string
  /** The choices offered, when it offered any. */
  choicesOffered?: string[] | null
  /** A choice or typed text, a list for multi-select, null for a question left blank. */
  answer: string | string[] | null
}

/** What a result says one question asked, and the answers it holds. */
export interface ClarifyAsked {
  question?: string
  answers: string[]
}

/** What a result reads as: each question with its answers, and how the wait ended. */
export interface ClarifyRead {
  asked: ClarifyAsked[]
  outcome?: string
}

/**
 * The questions a list of them carries, in the agent's order: the one reading of
 * `{ id?, question?, choices?, multi_select? }[]`, shared by a `clarify.request` event, a run
 * prompt's own list and the arguments of the call that asked. An entry with no words is no
 * question, and a question's choices are what make it a multi-select one.
 */
export function questionsIn(list: unknown): ClarifyQuestion[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((entry, index) => {
    const raw = (entry ?? {}) as Record<string, unknown>
    if (typeof raw.question !== "string" || !raw.question.trim()) return []
    const choices = Array.isArray(raw.choices)
      ? raw.choices.filter((one): one is string => typeof one === "string" && Boolean(one.trim()))
      : []
    return [
      {
        id: typeof raw.id === "string" && raw.id ? raw.id : `q${index}`,
        question: raw.question.trim(),
        ...(choices.length ? { choices, multiSelect: raw.multi_select === true } : {}),
      },
    ]
  })
}

/**
 * The page a question is on, by its words: the one rule every reader of a question set matches by.
 * Hermes asks off its own local viewers with a localized hint on the lines after the question, so
 * where no question is the words exactly, the one they start with, up to a newline, is.
 */
export function questionAt(questions: Pick<ClarifyQuestion, "question">[], asked: string): number {
  const text = asked.trim()
  if (!text) return -1
  const exact = questions.findIndex((one) => one.question === text)
  if (exact >= 0) return exact
  return questions.findIndex((one) => text.startsWith(`${one.question}\n`))
}

const listOf = (value: unknown) =>
  (Array.isArray(value) ? value : [value])
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => String(item).trim())

/**
 * What Hermes's `clarify` tool returns for the answers given, so a question reads the same live as
 * it will from the transcript: `{ responses, outcome }`, one response per question. A blank answer
 * is `skipped` when the form was submitted and `unanswered` when the window closed, which is how
 * Hermes itself names them.
 */
export function clarifyResult(responses: ClarifyResponse[], outcome: string): string {
  return JSON.stringify({
    responses: responses.map((response) => {
      const answer = listOf(response.answer)
      return {
        question: response.question,
        choices_offered: response.choicesOffered ?? null,
        status: answer.length ? "answered" : outcome === "submitted" ? "skipped" : "unanswered",
        user_response: answer.length ? response.answer : null,
      }
    }),
    outcome,
  })
}

/** A result's responses as the host wrote them, so an answer already given is never re-shaped. */
function responsesIn(result?: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(result ?? "")
    return Array.isArray(parsed?.responses) ? parsed.responses : []
  } catch {
    return []
  }
}

/**
 * A result with one more answer in it. Hermes puts one prompt at a time, so a call that asked
 * several questions is answered once per question: each answer joins the responses it already
 * holds — its own answer given again replaces that one — and the outcome is the one given.
 */
export function clarifyAnswered(
  result: string | undefined,
  response: ClarifyResponse,
  outcome: string,
): string {
  const held = responsesIn(result).filter((one) => one?.question !== response.question)
  const written = JSON.parse(clarifyResult([response], outcome)).responses[0]
  return JSON.stringify({ responses: [...held, written], outcome })
}

/** What Hermes's `clarify` route reads as a question skipped (`SKIP_WORD` in `tools/clarify_gateway.py`). */
export const SKIP_WORD = "skip"

/**
 * A question Hermes's run route records as answered with the word it was skipped by: the route
 * stores the reply as sent, where its own surfaces turn the word into no answer. A choice the
 * question really offered under that name is an answer.
 */
function skipped(response: Record<string, unknown>): boolean {
  const said = response?.user_response
  if (typeof said !== "string" || said.trim().toLowerCase() !== SKIP_WORD) return false
  const offered = Array.isArray(response?.choices_offered) ? response.choices_offered : []
  return !offered.some((one) => typeof one === "string" && one.trim().toLowerCase() === SKIP_WORD)
}

/**
 * What a call asked and was answered: Hermes's `{ responses, outcome }`, or the one answer older
 * shapes and plain text carry. `fallbackQuestion` is the call's own label, which is its first
 * question where the result names none.
 */
export function clarifyRead(result?: string, fallbackQuestion?: string): ClarifyRead {
  if (!result)
    return { asked: fallbackQuestion ? [{ question: fallbackQuestion, answers: [] }] : [] }
  try {
    const parsed = JSON.parse(result)
    const outcome =
      typeof parsed?.outcome === "string"
        ? parsed.outcome
        : parsed?.timed_out === true
          ? "timed_out"
          : undefined
    if (Array.isArray(parsed?.responses)) {
      return {
        outcome,
        asked: parsed.responses.map((response: Record<string, unknown>) => ({
          question: typeof response?.question === "string" ? response.question : undefined,
          answers: skipped(response) ? [] : listOf(response?.user_response),
        })),
      }
    }
    const direct = typeof parsed === "string" ? [parsed] : []
    const keyed = ["user_response", "response", "answer", "choice"].flatMap((key) =>
      listOf(parsed?.[key]),
    )
    return { outcome, asked: [{ question: fallbackQuestion, answers: [...direct, ...keyed] }] }
  } catch {
    return { asked: [{ question: fallbackQuestion, answers: [result] }] }
  }
}
