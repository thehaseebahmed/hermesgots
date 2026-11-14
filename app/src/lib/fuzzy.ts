/**
 * Code's search: forgiving of what a reader half-remembers rather than a query language (ADR 0093).
 * A query matches a row when its letters appear in order anywhere in the row's own words — so
 * `authref` finds `auth-refactor` — and a contiguous hit ranks above a scattered one, so a list
 * narrowed by a query keeps a useful order without the sort being rewritten underneath it.
 */

/** How well a query matched: 2 for the words run together somewhere, 1 for letters in order, 0 none. */
export type MatchRank = 2 | 1 | 0

/** A haystack with the noise taken out: accents folded, lower case, and anything that isn't a letter or a number read as a space. */
function plain(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

function queryWords(query: string) {
  return plain(query).split(" ").filter(Boolean)
}

/** Whether the letters of `word` appear in `text` in order, gaps allowed. */
function inOrder(word: string, text: string) {
  let cursor = 0
  for (const letter of word) {
    const found = text.indexOf(letter, cursor)
    if (found < 0) return false
    cursor = found + 1
  }
  return true
}

function rankOf(words: string[], haystack: string | (string | undefined)[]): MatchRank {
  if (!words.length) return 2
  const text = plain(Array.isArray(haystack) ? haystack.filter(Boolean).join(" ") : haystack)
  const together = text.replace(/ /g, "")
  if (words.every((word) => together.includes(word))) return 2
  return words.every((word) => inOrder(word, text)) ? 1 : 0
}

/**
 * How well one row answers a query: 2 where every word is found as typed (the words run together
 * once punctuation is dropped), 1 where the words are only found as letters in order, 0 where one of
 * them isn't there at all. An empty query matches everything at the top rank.
 */
export function matchRank(query: string, haystack: string | (string | undefined)[]): MatchRank {
  return rankOf(queryWords(query), haystack)
}

/**
 * The rows a query keeps, best match first and the list's own order inside a rank — a search
 * narrows a list, it never re-orders one. `words` reads each row's own haystack, and the query is
 * plained once here rather than once per row: this runs on every keystroke.
 */
export function filterByFuzzy<T>(
  items: readonly T[],
  query: string,
  words: (item: T) => (string | undefined)[],
): T[] {
  const wanted = queryWords(query)
  if (!wanted.length) return [...items]
  const ranks = items.map((item) => rankOf(wanted, words(item)))
  const kept = (rank: MatchRank) => items.filter((_, index) => ranks[index] === rank)
  return [...kept(2), ...kept(1)]
}
