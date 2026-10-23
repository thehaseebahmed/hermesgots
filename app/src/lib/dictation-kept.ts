import type { DictationPiece } from "@/lib/db"

export const SAVE_MS = 2000

/** Shown when a kept take is offered again, with Retry and Discard. */
export const RESTORED = "This recording hasn't been transcribed yet."

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
