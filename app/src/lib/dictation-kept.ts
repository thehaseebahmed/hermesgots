/**
 * What a take leaves on the device when it is cut short: its audio as it was made, under its
 * composer's key, written at a pace a slice every 250 ms can afford, and asked for whole when the
 * take comes back. Import-free, so `scripts/test-dictation-kept.mjs` runs it as a pure rule.
 */
import type { DictationPiece } from "@/lib/db"

/** How often a live take's audio is written: a slice every 250 ms is not a write every 250 ms. */
export const SAVE_MS = 2000

/** Shown when a kept take is offered again, with Retry and Discard. */
export const RESTORED = "This recording hasn't been transcribed yet."

/** A take as it is held to be written: its audio, and where the caret was when it began. */
export interface KeptTake {
  pieces: DictationPiece[]
  caret?: number
}

/**
 * The audio of a kept take that has no text yet, joined in the order it was made: a take that came
 * back is no longer live, so it is asked for whole rather than a piece at a time. Null when every
 * piece already has its text, or nothing was recorded.
 */
export function keptAudio(pieces: DictationPiece[]): Blob | null {
  const audio = pieces.filter((piece) => piece.text === null && piece.blob.size)
  if (!audio.length) return null
  return new Blob(
    audio.map((piece) => piece.blob),
    { type: audio[0].blob.type || "audio/webm" },
  )
}

type Write = (take: KeptTake | null) => Promise<unknown>

export interface Keeper {
  /** Holds the take as it stands; `now` writes it at once, which is how a take ends or is let go. */
  keep(take: KeptTake, now?: boolean): Promise<unknown>
  /** Writes what is held now. */
  flush(): Promise<unknown>
  /** Deletes what was kept, after every write already asked for. */
  drop(): Promise<unknown>
}

/**
 * Writes a take to the device one write at a time and no more often than `ms`, so the pace of the
 * recording never becomes the pace of the disk. A composer with no key keeps nothing.
 */
export function keeper(
  id: string | undefined,
  write: Write,
  { ms = SAVE_MS }: { ms?: number } = {},
): Keeper {
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<unknown> = Promise.resolve()
  let held: KeptTake | null = null
  let holding = false

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!holding) return writing
    holding = false
    const take = held
    held = null
    writing = writing.then(() => (id ? write(take) : undefined)).catch(() => undefined)
    return writing
  }

  const keep = (take: KeptTake, now = false) => {
    if (!id) return writing
    held = take
    holding = true
    if (now) return flush()
    timer ??= setTimeout(() => void flush(), ms)
    return writing
  }

  const drop = () => {
    holding = false
    held = null
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    writing = writing.then(() => (id ? write(null) : undefined)).catch(() => undefined)
    return writing
  }

  return { keep, flush, drop }
}
