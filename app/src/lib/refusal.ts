/**
 * Whose words a failed write shows, and where they go: one decision, made once per failure.
 *
 * A host that refused in its own words gets them held, so the surface that caused the write draws
 * them beside the control still on screen. A host that sent no usable words — one that never
 * landed, one that answered blankly, one whose refusal the app itself wrote — leaves the app its
 * own sentence, said in passing: there is nothing of the host's to keep.
 *
 * Import-free but for a type, so `scripts/test-refusal.mjs` runs it as a pure rule. The hold a
 * surface keeps is `useRefusal` (`lib/use-refusal.ts`), the one caller that turns this answer into
 * state and a toast — the split `busy-words.ts` and `use-busy-word.ts` already keep.
 */

/** What `attempt` answered: it landed, or it did not and here is what can be said about it. */
export type Attempted = { ok: true } | { ok: false; said?: string; alone: string }

/**
 * The two ways a failure can be worded: `hold` is the host's own sentence, for the surface to draw,
 * and `say` is the app's, for a toast. Never both, and neither for a write that landed.
 */
export type RefusalWords = { hold?: string; say?: string }

/** The one decision: whose words a failure shows. */
export function refuse(result: Attempted): RefusalWords {
  if (result.ok) return {}
  const said = result.said?.trim()
  return said ? { hold: said } : { say: result.alone }
}

/**
 * The one refusal a surface holds. `write` is a write of that surface's — cleared as it starts and
 * answered where it was made — and `dismiss` is the reader's control; both leave nothing to draw.
 */
export type RefusalHold = {
  words?: string
  /** The answer `attempt` gave, drawn or said, as `refuse` decides. */
  refuse: (result: Attempted) => void
  /** Runs one write of this surface's, answering whether it landed. */
  write: (what: string, action: () => Promise<unknown>) => Promise<boolean>
  clear: () => void
  dismiss: () => void
}
