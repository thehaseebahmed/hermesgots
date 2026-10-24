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
 * or the Steer by default setting — the host's reply takes one, and the message can be one.
 */
export function midReply(
  attachments: Carried[],
  { steer, hostTakesIt = true }: { steer: boolean; hostTakesIt?: boolean },
): MidReply {
  return steer && hostTakesIt && canSteer(attachments) ? "steer" : "queue"
}
