/** What broke, which is what decides what the bar suggests trying. */
export type DictationFailureKind =
  /** The host went away, or the take it was holding ended. */
  | "host"
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
  host: "Check that this bot's host is running, then try again.",
  microphone: "Check the microphone in this app's permissions, then try again.",
  clip: "Try again, or type it instead.",
}

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

function messageOf(error: unknown, otherwise: string): string {
  // A browser's own TypeError ("Failed to fetch") is not a sentence to show a person; anything the
  // host answered with carries the host's reason and is.
  if (error instanceof TypeError) return otherwise
  return error instanceof Error && error.message ? error.message : otherwise
}
