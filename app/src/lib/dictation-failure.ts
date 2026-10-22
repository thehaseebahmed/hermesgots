/**
 * A take that failed, as the voice bar says it: what failed — in the host's own words where it gave
 * them — and what to try, so a broken take reads as a broken take and not a broken app.
 *
 * The kind is what decides the advice, so a take that couldn't open, a speech model that didn't
 * load, a host that went away and a microphone that wouldn't open each tell the user the one thing
 * that might fix them. Import-free, so `scripts/test-dictation-failure.mjs` runs it as a pure rule.
 */

/** What broke, which is what decides what the bar suggests trying. */
export type DictationFailureKind =
  /** The take couldn't open: the host refused, can't dictate, or never answered. */
  | "start"
  /** The host's speech model didn't load, so the take never began. */
  | "model"
  /** The host went away, or the take it was holding ended. */
  | "host"
  /** The host couldn't decode or transcribe what it was sent. */
  | "decode"
  /** The microphone itself: blocked, missing, taken, silent or stopped. */
  | "microphone"
  /** A recorded clip the batch route couldn't turn into text. */
  | "clip"

/** A failure as the bar shows it: a sentence on what failed, one on what to try. */
export interface DictationFailure {
  /** What failed, in the host's own words where it gave them. */
  message: string
  /** What to try, in one sentence. */
  advice: string
  /** Whether Retry is offered: a fresh take, or the recording offered again. */
  retry: boolean
  /** Whether closing this failure throws a recording away, rather than just the message. */
  discard: boolean
}

/** The one thing worth trying for each kind of failure. */
const ADVICE: Record<DictationFailureKind, string> = {
  start: "Check that this bot's host can dictate, then try again.",
  model:
    "Try again — a cold host loads its model — or pick a smaller speech model on the Dictation tab.",
  host: "Check that this bot's host is running, then try again.",
  decode: "Try again; the words it already heard are kept.",
  microphone: "Check the microphone in this app's permissions, then try again.",
  clip: "Try again, or type it instead.",
}

const TOO_LONG = "The bot took too long to hear the dictation."
const TOO_LONG_CLIP = "The bot took too long to transcribe."

/** A failure of `kind`, with the sentence the bar shows for it. */
export function failure(
  kind: DictationFailureKind,
  message: string,
  options: { advice?: string; retry?: boolean; discard?: boolean } = {},
): DictationFailure {
  return {
    message,
    advice: options.advice ?? ADVICE[kind],
    retry: options.retry ?? true,
    discard: options.discard ?? false,
  }
}

/** A take that couldn't open: the host's refusal, its model not loading, or no answer at all. */
export function startFailure(error: unknown): DictationFailure {
  if (error instanceof DOMException && error.name === "AbortError")
    return failure("host", "The bot's host didn't answer in time.")
  const status = statusOf(error)
  if (status === 502)
    return failure("model", messageOf(error, "The host's speech model didn't load."))
  if (status === 409 || status === 501 || status === 403)
    return failure("start", messageOf(error, "The bot's host can't start a dictation."))
  return failure("host", messageOf(error, "The bot's host didn't start the dictation."))
}

/** A take that failed while it was being heard: what the host answered, or the transport failing. */
export function takeFailure(error: unknown, otherwise: DictationFailureKind = "host"): DictationFailure {
  if (error instanceof DOMException && error.name === "AbortError")
    return failure(otherwise, TOO_LONG)
  const status = statusOf(error)
  if (status === 404 || status === 410) return failure("host", messageOf(error, "This dictation has ended."))
  if (status === 501) return failure("start", messageOf(error, "The bot's host can't dictate."))
  if (status === 502) return failure("decode", messageOf(error, "Couldn't hear the recording."))
  return failure(otherwise, messageOf(error, "Couldn't hear the recording."))
}

/** A recorded clip the batch route couldn't turn into text, with the wait's own reason when it ran out. */
export function clipFailure(error: unknown): DictationFailure {
  if (error instanceof DOMException && error.name === "AbortError")
    return failure("clip", TOO_LONG_CLIP, { discard: true })
  return failure("clip", messageOf(error, "Couldn't transcribe the recording."), { discard: true })
}

/**
 * The microphone refusing the take. A permission the user has to change is the one failure a retry
 * can't answer, so its Retry isn't offered; anything else — a mic another app is holding, one that
 * went quiet — may well work on the next try.
 */
export function microphoneFailure(message: string, blocked = false): DictationFailure {
  return failure("microphone", message, { retry: !blocked })
}

/** Whether the microphone was refused by a permission only the user can grant. */
export function blockedMicrophone(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : ""
  return name === "NotAllowedError" || name === "SecurityError"
}

/** The two sentences the bar reads out, for a screen reader and a line's own tooltip. */
export function failureLine(failed: DictationFailure): string {
  return `${failed.message} ${failed.advice}`
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status
  return typeof status === "number" ? status : undefined
}

function messageOf(error: unknown, otherwise: string): string {
  // A browser's own TypeError ("Failed to fetch") is not a sentence to show a person; anything the
  // host answered with carries the host's reason and is.
  if (error instanceof TypeError) return otherwise
  return error instanceof Error && error.message ? error.message : otherwise
}
