/**
 * A question card's form as the reader filled it in, and as the page keeps it between the prompts of
 * one call.
 *
 * Hermes asks a clarify call's questions one prompt at a time (`gateway/session_pending_controls.py`),
 * so the card the reader fills in is answered once per prompt, with no tap after the first. What
 * carries the answers from one prompt to the next is this form — the picks as they were given, not
 * the wire's answers — kept by the thread so a card drawn again opens with them (`TakenForm`).
 *
 * It outlives the page as well: a phone that steps out of a chat mid-call reads the form back from
 * the device's own record when the chat opens again (ADR 0174).
 */

import type { ClarifyQuestion } from "@/lib/db"

/** What the user has picked or typed for one question, before it's sent. */
export interface Picked {
  choices: string[]
  other: string
  usingOther: boolean
}

/** A form as the reader filled it in, by question id. */
export type PickedForm = Record<string, Picked>

/** Nothing picked yet: a question the card has not been answered on reads as this. */
export const NOTHING_PICKED: Picked = Object.freeze({ choices: [], other: "", usingOther: false })

/** The answer a question carries, as the wire takes it: a choice, a typed text, a list, or none. */
export function answerOf(question: ClarifyQuestion, picked: Picked): string | string[] | null {
  const typed = picked.other.trim()
  if (!question.choices) return typed || null
  if (question.multiSelect) {
    const all = [...picked.choices, ...(picked.usingOther && typed ? [typed] : [])]
    return all.length ? all : null
  }
  if (picked.usingOther) return typed || null
  return picked.choices[0] ?? null
}

/**
 * The form a card took for a call, and the prompt it last answered with it. The card is handed one
 * when it is drawn again, so a question the reader already gave is not asked twice and one they gave
 * ahead is answered with no tap.
 */
export interface TakenForm {
  /** The form as the reader filled it in, per question, so a card drawn again shows what they gave. */
  form: PickedForm
  /**
   * The prompt the form last answered, so a question already sent is not sent again — while this page
   * is the one holding it. It is the send in flight, and the device keeps only the marker the host's
   * own answer confirms (`HeldForm.delivered`): a page that died with an answer in flight cannot tell
   * whether the host took it, and a marker honoured there would leave the question unanswerable from
   * this device until the run ended (`SessionState.clarifyForm`).
   */
  answeredPrompt?: string
}

/**
 * A taken form as the thread holds it: the run that asked the call, the card's own key for it, and
 * the question whose answer the host is known to have taken, so a form is never answered under a name
 * other than the one it was stored with — and a chat opened again is told what it may skip.
 */
export interface HeldForm {
  run: string
  key: string
  taken: TakenForm
  /**
   * The question the host's own answer to this form settled: stamped only once the page saw it take
   * the answer, which is the one fact a device may keep. `TakenForm.answeredPrompt` is the send in
   * flight, and a page that dies with that in flight cannot vouch for it (`SessionState.clarifyForm`).
   */
  delivered?: string
}
