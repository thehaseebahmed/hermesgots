import type { MediaState } from "./media-source.ts"

/** How far a file's read has got, as a cell draws it: still out, drawn, or failed and askable again. */
export type MediaStage = "reading" | "ready" | "failed"

/**
 * The one place the four states a read can be in (`media-source.ts`) become the three a picture has
 * room for. A host with no such file draws as a read that failed, since a cell that keeps its place
 * may still be asked again. Import-free but for a type, so a unit test runs it.
 */
export const mediaStage = (state?: MediaState): MediaStage =>
  state?.status === "ready" ? "ready" : state?.status === "reading" ? "reading" : "failed"
