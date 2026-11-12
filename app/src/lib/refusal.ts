/**
 * Whose words a failed write shows, and where they go: one decision, made once per failure.
 *
 * A host that refused in its own words gets them held, so the surface that caused the write draws
 * them beside the control still on screen. A host that sent no usable words — one that never
 * landed, one that answered blankly, one whose refusal the app itself wrote — leaves the app its
 * own sentence, said in passing: there is nothing of the host's to keep.
 *
 * Import-free but for `words.ts`'s `spoken`, so `scripts/test-refusal.mjs` runs it as a pure rule.
 * The hold a surface keeps is `useRefusal` (`lib/use-refusal.ts`), the one caller that turns this
 * answer into state and a toast — the split `busy-words.ts` and `use-busy-word.ts` already keep.
 */

import { spoken } from "./words.ts"

/**
 * What a write answered: it landed, or it did not and here is what can be said about it. A failure
 * keeps the error it caught, so a caller that has to tell one failure from another — a run the host
 * no longer holds from a stop it refused — reads that rather than a flag smuggled beside the call.
 */
export type Attempted = { ok: true } | AttemptFailure

/**
 * A write that did not land, worded one of two ways: `said` is the host's own sentence, for the
 * surface to draw, and `alone` is the app's own, for the app to say in passing. One of the two, and
 * never a `said` the host didn't write. `caught` is the error the write threw, where it threw one, so
 * a caller that has to tell one failure from another reads it rather than a flag kept beside the call.
 */
export type AttemptFailure =
  | { ok: false; said: string; caught?: unknown }
  | { ok: false; alone: string; caught?: unknown }

/**
 * A failure the app worded itself: a value it refused before writing, a permission the platform
 * withheld, a host that answered with nothing it could draw. Its `message` is the app's sentence, so
 * `failed` words it as the app's own — said in passing — rather than holding it as the host's.
 */
export class AppWords extends Error {}

/**
 * The one failure a caught error makes of a write: the host's words where it sent a sentence a
 * person can read, and `alone` where it didn't — a bare `TypeError` from `fetch` included, since
 * "Failed to fetch" is the browser's sentence and not the host's (`spoken` in `words.ts` decides
 * that the way `dictation-failure.ts` already does). One shape for every caller that catches an
 * error itself, so none of them decides separately whose words it just caught.
 */
export function failed(error: unknown, alone: string): AttemptFailure {
  if (error instanceof AppWords) return { ok: false, caught: error, alone: error.message || alone }
  const said = spoken(error, "").trim()
  return said ? { ok: false, caught: error, said } : { ok: false, caught: error, alone }
}

/**
 * The two ways a failure can be worded: `hold` is the host's own sentence, for the surface to draw,
 * and `alone` is the sentence the call would have said by itself — the app's own, for a toast.
 */
type RefusalWords = { hold?: string; alone?: string }

/** The one decision: whose words a failure shows. `failed` has already trimmed and chosen. */
export function refuse(result: Attempted): RefusalWords {
  if (result.ok) return {}
  return "said" in result ? { hold: result.said } : { alone: result.alone }
}

/**
 * The one refusal a surface holds. `write` is a write of that surface's — cleared as it starts and
 * answered where it was made — and `dismiss` is the reader's control; both leave nothing to draw.
 */
export type RefusalHold = {
  words: string | undefined
  refuse: (result: Attempted) => void
  write: (what: string, action: () => Promise<unknown>) => Promise<boolean>
  clear: () => void
  dismiss: () => void
}
