/**
 * Hermes's `clarify` tool result, both ways: the one the app writes when the user answers, and the
 * reading of a result the host wrote. One home, so a card, the transcript's own row and the plain
 * view every screen draws can never disagree about the shape.
 */

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
          answers: listOf(response?.user_response),
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
