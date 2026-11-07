/**
 * How a message sent while a reply runs goes: a steer when the send asks to and the message can be
 * one. A steer is text, so a message carrying only files can steer — its files reach the model as
 * marker lines — while one carrying a photo's bytes cannot, since those ride in the message itself
 * for the model to read. Import-free but for `attachment-caps.ts`, so `scripts/test-steer.mjs` runs
 * it as a pure rule.
 */
import { carriesPart } from "./attachment-caps.ts"

/** What an attachment does to a steer, which is all this rule needs of it. */
export interface Carried {
  /** The bytes the model is sent in the message itself, where the attachment carries any. */
  inline?: unknown
}

export type MidReply = "steer" | "queue"

/**
 * Whether a message carrying `attachments` can go as a steer: a file's content is a marker line,
 * which is text, and a photo's bytes ride beside it in the message, which a steer cannot carry.
 */
export function canSteer(attachments: Carried[] = []) {
  return !attachments.some(carriesPart)
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

/** A steer's own text, without the marker Hermes wraps it in for the model. */
export function steerText(content: string) {
  return content
    .trim()
    .replace(/^\[OUT-OF-BAND USER MESSAGE[^\n]*\]\n?/, "")
    .replace(/\n?\[\/OUT-OF-BAND USER MESSAGE\]$/, "")
    .trim()
}
