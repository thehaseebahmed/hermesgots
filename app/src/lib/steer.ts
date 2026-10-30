/**
 * How a message sent while a reply runs goes: a steer when the send asks to and the message can be
 * one. A steer is text, so a message carrying only files can steer — its files reach the model as
 * marker lines — while one carrying an image cannot, since the image rides in the message itself for
 * the model to read. Import-free, so `scripts/test-steer.mjs` runs it as a pure rule.
 */

/** What an attachment does to a steer, which is all this rule needs of it. */
export interface Carried {
  /** Whether its content goes to the model inline, as the model reads it. */
  image?: boolean
}

export type MidReply = "steer" | "queue"

/**
 * Whether a message carrying `attachments` can go as a steer: a file's content is a marker line,
 * which is text, and an image's rides beside it in the message, which a steer cannot carry.
 */
export function canSteer(attachments: Carried[] = []) {
  return !attachments.some((attachment) => attachment.image)
}

/**
 * Where a message sent mid-reply goes: `steer` when the send asked to steer — an explicit `/steer`,
 * or the Steer by default setting — a reply is running here for a steer to reach, and the message
 * can be one.
 */
export function midReply(
  attachments: Carried[],
  { steer, running = true }: { steer: boolean; running?: boolean },
): MidReply {
  return steer && running && canSteer(attachments) ? "steer" : "queue"
}

/** Whether the send asked to steer: its own `/steer` or `/queue`, else the setting, where the reply
 * takes one. */
export function steerAsked(
  chosen: MidReply | undefined,
  { byDefault, steerable }: { byDefault: boolean; steerable: boolean },
) {
  return chosen ? chosen === "steer" : byDefault && steerable
}

/**
 * Whether the composer may offer a steer. The offer follows the run, not the event stream this page
 * happens to hold: returning to a session joins its run a moment later and a phone that went away
 * drops the stream, while the send itself reaches the run by its id — so an offer gated on the join
 * flips between Steer and Queue a message as one run hands over to the next.
 */
export function steerOffered({
  followed = false,
  liveRun,
  steerable,
}: {
  /** This page follows the run's events now. */
  followed?: boolean
  /** The run the host lists for the session. */
  liveRun?: string
  /** A host that takes a steer. */
  steerable: boolean
}) {
  return steerable && (followed || Boolean(liveRun))
}

/** A steer's own text, without the marker Hermes wraps it in for the model. */
export function steerText(content: string) {
  return content
    .trim()
    .replace(/^\[OUT-OF-BAND USER MESSAGE[^\n]*\]\n?/, "")
    .replace(/\n?\[\/OUT-OF-BAND USER MESSAGE\]$/, "")
    .trim()
}
