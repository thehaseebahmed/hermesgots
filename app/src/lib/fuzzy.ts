/**
 * Code's search: forgiving of what a reader half-remembers rather than a query language (ADR 0093).
 * A query matches a row when its letters appear in order anywhere in the row's own words — so
 * `authref` finds `auth-refactor` — and a contiguous hit ranks above a scattered one, so a list
 * narrowed by a query keeps a useful order without the sort being rewritten underneath it.
 *
 * Import-free, so it runs under plain node (`scripts/test-fuzzy.mjs`).
 */

/** How well a query matched: 2 for the words run together somewhere, 1 for letters in order, 0 none. */
export type MatchRank = 2 | 1 | 0

const LETTER = /[a-z0-9]/

/** A haystack with the noise taken out: lower case, and punctuation read as a space. */
function plain(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** Whether every word of the query can be found in the text, each in order, in any order. */
function wordsMatch(words: string[], text: string) {
  return words.every((word) => {
    const at = text.indexOf(word)
    if (at >= 0) return true
    // Letters in order, gaps allowed: the word as a subsequence of the text.
    let cursor = 0
    for (const letter of word) {
      if (!LETTER.test(letter)) continue
      const found = text.indexOf(letter, cursor)
      if (found < 0) return false
      cursor = found + 1
    }
    return true
  })
}

/**
 * How well one row answers a query: 2 where every word is found as typed (the words run together
 * once punctuation is dropped), 1 where the words are only found as letters in order, 0 where one of
 * them isn't there at all. An empty query matches everything at the top rank.
 */
export function matchRank(query: string, haystack: string | (string | undefined)[]): MatchRank {
  const text = plain(Array.isArray(haystack) ? haystack.filter(Boolean).join(" ") : haystack)
  const words = plain(query).split(" ").filter(Boolean)
  if (!words.length) return 2
  const together = text.replace(/ /g, "")
  if (words.every((word) => together.includes(word))) return 2
  return wordsMatch(words, text) ? 1 : 0
}

/**
 * The rows a query keeps, best match first and the list's own order inside a rank — a search
 * narrows a list, it never re-orders one. `words` reads each row's own haystack.
 */
export function filterByFuzzy<T>(
  items: readonly T[],
  query: string,
  words: (item: T) => (string | undefined)[],
): T[] {
  if (!plain(query)) return [...items]
  const ranked = items
    .map((item) => ({ item, rank: matchRank(query, words(item)) }))
    .filter((row) => row.rank > 0)
  // Stable: the array's own order survives inside each rank.
  return [2, 1].flatMap((rank) => ranked.filter((row) => row.rank === rank).map((row) => row.item))
}
