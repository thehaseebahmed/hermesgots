/**
 * A Prompt's source, as its row reads it: whether the words a project holds are still the library
 * entry they were copied from. A pick is a copy — the host can't read the account's library — so the
 * only record of where words came from is the entry id the host keeps beside them, and the only way
 * to tell a copy from an original is to compare the two texts (ADR 0043).
 *
 * The rule is a comparison, not a version: nothing extra is stored or synced to know an entry moved
 * on. And it is silent wherever it could lie — no source, or a source whose entry this device no
 * longer holds (deleted, or a library signed out here) — so a copy of a deleted entry simply stands,
 * and words the user typed themselves are never called stale. Import-free, so
 * `scripts/test-prompt-source.mjs` runs it as a pure rule.
 */
export type PromptSourceState = "none" | "original" | "changed"

/**
 * What a Prompt's row should say about its source: `"changed"` where the entry with that id now
 * holds other words (the row offers the pull), `"original"` where the copy still matches it, and
 * `"none"` where there is nothing to compare — no source recorded, or no entry here to compare with.
 *
 * The ends are not part of the comparison. The host trims a Prompt when it stores one
 * (`afk.prompt_text`), so a pick of an entry whose body starts or ends with whitespace lands here
 * without it, and a copy that is still the entry's words would otherwise read as changed the moment
 * it was picked. What differs inside the words is still a difference.
 */
export function promptSourceState(
  promptId: string | null,
  prompt: string,
  entry: { body: string } | null | undefined,
): PromptSourceState {
  if (!promptId) return "none"
  if (!entry) return "none"
  return entry.body.trim() === prompt.trim() ? "original" : "changed"
}
