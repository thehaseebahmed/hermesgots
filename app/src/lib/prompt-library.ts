/**
 * The account's prompt library, as rules: what an entry is, the list's order, the one line a row
 * previews a body on, the tags read off a field, and when the library is shown at all. No Dexie and
 * no fetch here — `prompt-library-store.ts` keeps the entries on the device — so
 * `scripts/test-prompt-library.mjs` runs these as a pure rule.
 *
 * An entry is plain text: a name, tags it is found by, and the body a pick copies into a project's
 * Prompt. Nothing here substitutes anything into the body — a Prompt is sent as it is written.
 */
import type { Account } from "@/lib/account"
import type { SyncState } from "@/lib/sync"

export interface PromptEntry {
  id: string
  name: string
  tags: string[]
  body: string
  /** The record's own clock, which the sync document merges by. */
  updatedAt: number
}

/** What an entry is written from: its name, the tags it is found by, and the words it holds. */
export interface PromptDraft {
  name: string
  tags: string[]
  body: string
}

/** A tag has no surrounding space and no comma in it; the list keeps each one once, however cased. */
export function promptTags(text: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const piece of text.split(",")) {
    const tag = piece.trim()
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    tags.push(tag)
  }
  return tags
}

/** The tags field a form opens on: one line, a comma between them. */
export function tagsText(tags: readonly string[]): string {
  return tags.join(", ")
}

/** A name as it is kept: trimmed, and never empty — an entry without one can't be found or picked. */
export function promptTitle(name: string): string {
  return name.trim()
}

/** Whether a draft is a library entry yet: it needs a name and words. */
export function promptFilled({ name, body }: { name: string; body: string }): boolean {
  return promptTitle(name).length > 0 && body.trim().length > 0
}

/**
 * The order the library is read in: by name, so an entry stays where the user last saw it however
 * recently it was edited; two names differing only in case keep their own order by id, which is the
 * entry's id and never changes.
 */
export function sortedPrompts<T extends { id: string; name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((one, other) => {
    const name = one.name.toLowerCase().localeCompare(other.name.toLowerCase())
    return name !== 0 ? name : one.id.localeCompare(other.id)
  })
}

/**
 * A Prompt on one line: markdown's block marks off it and its lines run together, since a row names
 * the instruction rather than drawing it — the editor is where it reads as written. The library's
 * list previews a body with the same rule (`bodyPreview`), so a heading reads the same in the
 * project's row and in the entry it was copied from.
 */
export function promptLine(prompt: string): string {
  return prompt
    .split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join(" · ")
}

/**
 * A body on one line, for a list row: markdown's block marks off it, its lines run together, cut at
 * `max` characters with an ellipsis where it ran on — the words a pick copies are the body itself,
 * never this.
 */
export function bodyPreview(body: string, max = 96): string {
  const line = promptLine(body)
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…` : line
}

/**
 * Whether the library is offered at all: it lives in the account's encrypted store, so it needs a
 * signed-in account and a vault open on this device. Anything else — signed out, a vault still
 * locked, a first run — draws today's editor and nothing more. Both answers are typed from the state
 * they come out of (`account.ts`'s Account, `sync.ts`'s vault), so a status this device gains or
 * loses is a compile error here rather than a library offered where it can't be read.
 *
 * The imports are types alone, which is why this module is still import-free at run time:
 * `scripts/test-prompt-library.mjs` runs it as a pure rule.
 */
export function libraryReady(account: Account["status"], vault: SyncState["vault"]): boolean {
  return account === "signed-in" && vault === "unlocked"
}
