import type { MediaState } from "./media-source.ts"

/** How far a file's read has got, as a cell draws it: still out, drawn, or failed and askable again. */
export type MediaStage = "reading" | "ready" | "failed"

/**
 * The one place a read's states become the three a cell draws. A host with no such file is left to
 * whoever decides whether the file is drawn at all: this asks a cell to draw, and there is nothing.
 * Import-free but for a type, so `scripts/test-media-stage.mjs` runs it.
 */
export const mediaStage = (state?: MediaState): MediaStage =>
  state?.status === "ready" ? "ready" : state?.status === "reading" ? "reading" : "failed"
