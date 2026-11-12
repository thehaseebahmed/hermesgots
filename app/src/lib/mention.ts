/**
 * A mention, as the composer writes one: `@` opens a menu of this bot's sessions and of the host's
 * other bots, and a pick writes the picked name into the user's sentence.
 *
 * The token is the `@` that begins a word, which is what keeps an address an address: `a@b.com`
 * opens nothing, since the `@` there sits inside a word, and neither does `@a@b`, since no name
 * holds a second `@`. The span is computed the way `slashToken` computes its own — `end` is the
 * whitespace after the caret's word, or the text's end — so the composer reads whichever token
 * stands with one piece of code. A picked name may hold spaces while a typed query never does: a
 * space ends the word, and so ends the query.
 *
 * A name reaches the sentence as the words the user sees, and nothing else is done to it: no slug,
 * no case change, no truncation. The id that names it to a host rides in a marker line instead
 * (`mention-marker.ts`), since a `<textarea>` cannot hold a chip mid-text and one copy of the fact
 * cannot drift from the sentence it sits in.
 *
 * Import-free but for `word-pick.ts`, so the unit tier loads this file under
 * `node --experimental-strip-types`.
 */

import { pickWord } from "./word-pick.ts"

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char)

/** The `@`-word a caret sits in: `@week` in `ping @week| and then`. */
export interface MentionToken {
  /** Where the token's `@` is. */
  start: number
  /** One past the token's last character: the whitespace after it, or the text's end. */
  end: number
  /** What has been typed after the `@`, up to the caret. */
  query: string
  /** Whether the token is the whole message: nothing but whitespace around it. */
  alone: boolean
}

/**
 * The token the caret is in, or null when it isn't sitting in one. A token starts at the `@` that
 * begins a word — the message's first character, or the one after a space or a newline — so the
 * `@` of an address never opens the menu.
 */
export function mentionToken(text: string, caret: number): MentionToken | null {
  let start = caret
  while (start > 0 && !isSpace(text[start - 1])) start--
  if (text[start] !== "@") return null
  let end = caret
  while (end < text.length && !isSpace(text[end])) end++
  const query = text.slice(start + 1, caret)
  // A second `@` makes this an address or a handle the user is writing, not a tag: no name has one.
  if (query.includes("@")) return null
  const alone = `${text.slice(0, start)}${text.slice(end)}`.trim() === ""
  return { start, end, query, alone }
}

/** A session's title as it lands in a sentence: trimmed, its runs of whitespace made one space. */
export function mentionName(title: string): string {
  return title.trim().replace(/\s+/g, " ")
}

/** A picked name lands where the cursor is: `@name` replaces what was typed of the token. */
export function pickMention(text: string, token: MentionToken, name: string) {
  return pickWord(text, token, "@", name)
}
