/**
 * A mention, held in a message: picking a session or another bot in the composer puts that name
 * into the user's sentence, and the message they send then names it — one marker line per pick,
 * carrying the name the user saw and the id the host knows it by.
 *
 * A user row is its text and nothing else the fold reads, so the markers are the record, as
 * `point-marker.ts` does it: each line is a token pair the fold keys on and a sentence the model
 * reads. The token pair is the contract, so the words around it may be reworded without turning
 * every message that carried a mention back into words the user typed. The pair is exact and the
 * block sits under the words, so the same words typed into the field stay the user's own — and a
 * line typed by hand that is *exactly* a marker reads as one.
 *
 * Import-free on purpose: the unit tier loads this file under `node --experimental-strip-types`.
 */

/** What was picked: a session of this bot's, or another bot on its host. */
export type MentionKind = "session" | "bot"

/** One pick: the name the user saw, and the id the host knows it by. */
export interface Mention {
  /** What the user sees: a session's title, a bot's name. */
  name: string
  kind: MentionKind
  /** The handle its host knows it by: `hermesSessionId` for a session, `hermesProfile` for a bot. */
  id: string
}

/** A marker line begins with the first token and ends with the second; the pick sits between them. */
export const MENTION_OPEN = "[MENTION — "
export const MENTION_SEPARATOR = " | "
export const MENTION_SESSION = "session"
export const MENTION_BOT = "bot"
export const MENTION_CLOSE = "]"

const isMentionKind = (word: string): word is MentionKind =>
  word === MENTION_SESSION || word === MENTION_BOT

/** One mention as the model reads it. */
export function mentionLine(mention: Mention): string {
  return `${MENTION_OPEN}${mention.name}${MENTION_SEPARATOR}${mention.kind}: ${mention.id}${MENTION_CLOSE}`
}

/**
 * The mention a line names, or null for anything that isn't exactly one. A name may hold the
 * separator's own words, so it is split on the last one: the kind word and the id are what follows.
 */
export function mentionIn(line: string): Mention | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(MENTION_OPEN) || !trimmed.endsWith(MENTION_CLOSE)) return null
  const body = trimmed.slice(MENTION_OPEN.length, -MENTION_CLOSE.length)
  const at = body.lastIndexOf(MENTION_SEPARATOR)
  if (at <= 0) return null
  const name = body.slice(0, at).trim()
  const field = body.slice(at + MENTION_SEPARATOR.length)
  const colon = field.indexOf(": ")
  if (colon < 0) return null
  const kind = field.slice(0, colon).trim()
  const id = field.slice(colon + 2).trim()
  if (!isMentionKind(kind) || !name || !id) return null
  return { name, kind, id }
}

/** The message as the model reads it: what the user wrote, then a marker line per mention. */
export function mentionText(text: string, mentions: Mention[] = []): string {
  return [text.trimEnd(), ...mentions.map(mentionLine)].filter(Boolean).join("\n")
}

/**
 * The words a message carried, and the mentions it named: the marker lines are the trailing block,
 * so anything above the last line that isn't one is the user's own and stays words.
 */
export function mentionsIn(content: string): { text: string; mentions: Mention[] } {
  // Most messages name no mention, and this runs over every row of every fold: the marker is looked
  // for before the text is cut up at all, and then only from its end.
  if (!content.includes(MENTION_OPEN)) return { text: content, mentions: [] }
  const mentions: Mention[] = []
  let end = content.length
  while (end > 0) {
    // From `end - 2`: the newline at `end - 1` is the one that ended the line just read.
    const opensAt = content.lastIndexOf("\n", end - 2) + 1
    const mention = mentionIn(content.slice(opensAt, end))
    if (!mention) break
    mentions.unshift(mention)
    end = opensAt
  }
  if (!mentions.length) return { text: content, mentions: [] }
  return { text: content.slice(0, end).trimEnd(), mentions }
}
