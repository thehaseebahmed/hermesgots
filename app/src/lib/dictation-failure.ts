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

/**
 * A take the host couldn't finish: the bound it stated and then missed, a host that couldn't be
 * reached, or the host's own refusal. The audio stays, so closing the failure discards it.
 */
export function clipFailure(error: unknown, bound?: number): DictationFailure {
  if (error instanceof DOMException && error.name === "AbortError")
    return failure("clip", tookTooLong(bound), { discard: true })
  if (error instanceof TypeError)
    return failure("clip", "Couldn't reach the bot's host to finish the take.", { discard: true })
  return failure("clip", messageOf(error, "Couldn't finish the take."), { discard: true })
}

/** What the bar says when the host never answered its Confirm inside the bound it stated. */
export function tookTooLong(bound?: number): string {
  if (!bound) return "The bot didn't answer the take."
  const wait = bound < 1000 ? `${bound} ms` : `${Math.round(bound / 1000)} s`
  return `The bot didn't answer the take in ${wait}.`
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
