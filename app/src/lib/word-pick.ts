/**
 * A pick, as both of the composer's menus make it: the token's first character and what was typed
 * of it up to the caret are replaced by `<prefix><name>`, and whatever followed the caret —
 * including the rest of a word the token was typed into — stays where it was.
 *
 * One rule for `/` and `@` alike, because two copies of this arithmetic drift: a skill picked with
 * a space after it and a mention picked without one are the same bug twice, and a pick that eats
 * the word after it is the one a reader notices. It names no menu, so neither `slash.ts` nor
 * `mention.ts` has to know about the other.
 *
 * Import-free on purpose: the unit tier loads this file under `node --experimental-strip-types`.
 */

/** A token's head: where its `@` or `/` is, and what has been typed after it up to the caret. */
export interface PickedToken {
  start: number
  query: string
}

/**
 * A picked name lands where the cursor is: `<prefix><name>` replaces the token's first character
 * and the query up to the caret, and everything after the caret stays where it was.
 */
export function pickWord(text: string, token: PickedToken, prefix: string, name: string) {
  return replaceSpan(text, token.start, token.start + 1 + token.query.length, prefix, name)
}

/**
 * A span replaced by `<prefix><name>`, with one space after it unless the text already has
 * whitespace there, and the caret past that space: the end of the message has no character to keep
 * typing against, so it needs the space.
 */
export function replaceSpan(text: string, from: number, to: number, prefix: string, name: string) {
  const spaced = /\s/.test(text[to] ?? "")
  const picked = `${prefix}${name}${spaced ? "" : " "}`
  const next = text.slice(0, from) + picked + text.slice(to)
  return { text: next, caret: from + picked.length + (spaced ? 1 : 0) }
}
