/**
 * A bot's vocabulary: the names, product words and jargon its dictation is written with.
 *
 * The rules are pure — a list of words in, a list out — because three places have to agree on the
 * same list: the Dictation tab that edits it, the bot record that syncs it, and the start of a take
 * that sends it. A word is one line of text, the list holds each word once however it is cased, and
 * it is short, because the decoder's prompt it joins shares Whisper's few hundred tokens with the
 * text already heard.
 */

/** How many words a bot keeps. The newest are the ones kept when the list is full. */
export const MAX_WORDS = 50

/** How long one word may be: a name or a product word, not a sentence. */
export const MAX_WORD = 40

const same = (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase()

/** A word as the list keeps it: one line, no runs of space, no longer than `MAX_WORD`. */
export function cleanWord(raw: string): string {
  return raw.replace(/\s+/g, " ").slice(0, MAX_WORD).trim()
}

/**
 * The list with `raw` at its end. A word the list already holds is not added again — the spelling it
 * has is the one the take is biased towards — and past the cap the oldest word makes way, so what
 * the user has just typed is what its dictation leans on.
 */
export function addWord(words: readonly string[], raw: string): string[] {
  const word = cleanWord(raw)
  const kept = [...words]
  if (!word || words.some((held) => same(held, word))) return kept
  const next = [...kept, word]
  return next.length > MAX_WORDS ? next.slice(next.length - MAX_WORDS) : next
}

/** The list without `word`, matched however it is cased. */
export function removeWord(words: readonly string[], word: string): string[] {
  return words.filter((held) => !same(held, word))
}

/** A record's words as this app draws them: a synced or older record read back through the rules. */
export function readVocabulary(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.reduce<string[]>(
    (kept, item) => (typeof item === "string" ? addWord(kept, item) : kept),
    [],
  )
}
