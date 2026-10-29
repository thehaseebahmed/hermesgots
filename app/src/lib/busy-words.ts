export type BusyKind = "catching" | "thinking" | "writing"

/** Single words only: the status line is a mood, and what the bot really does stays in its rows. */
export const BUSY_WORDS: Record<BusyKind, readonly string[]> = {
  catching: [
    "Unspooling",
    "Rummaging",
    "Gathering",
    "Dredging",
    "Fetching",
    "Unpacking",
    "Collating",
    "Retrieving",
  ],
  thinking: [
    "Winnowing",
    "Plotting",
    "Untangling",
    "Mapping",
    "Squinting",
    "Weighing",
    "Sketching",
    "Charting",
  ],
  writing: [
    "Stitching",
    "Whittling",
    "Chiseling",
    "Composing",
    "Threading",
    "Kneading",
    "Burnishing",
    "Drafting",
  ],
}

/** How long a word stays before the next one. */
export const BUSY_WORD_MS = 4000

function hash(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * The word for a moment: it changes every `BUSY_WORD_MS`, never repeats the one before, and is the
 * same for the same seed and moment, so a streamed token redrawing the row never changes it.
 */
export function busyWord(kind: BusyKind, seed: string, now: number) {
  const words = BUSY_WORDS[kind]
  const tick = Math.floor(now / BUSY_WORD_MS)
  const start = hash(`${kind}:${seed}`) % words.length
  return `${words[(start + tick) % words.length]}…`
}
