import type { MediaItem } from "@/components/chat/media-gallery"
import type { PreviewItem } from "@/components/chat/previewer"
import { drawnCell, mediaKind } from "./media-kind.ts"
import type { MediaSources } from "./media-source.ts"
import { mediaStage } from "./media-stage.ts"

/** A reply's `MEDIA:<path>` tag as it was written: where the file lies, and the name to draw it by. */
export interface MediaTagItem {
  key: string
  path: string
  name: string
}

/** One item of a thread's media as the Previewer takes it: the same file, with the room its kind needs. */
export function previewItem(item: MediaItem, extra: Partial<PreviewItem> = {}): PreviewItem {
  return {
    key: item.key,
    name: item.name,
    type: item.type,
    size: item.size,
    kind: item.kind === "file" ? "image" : item.kind,
    src: item.src,
    state: item.state,
    note: item.note,
    ...extra,
  }
}

/**
 * A reply's tags as the thread draws them, from what the host answered for each — a tag still being
 * read carries no URL yet, and its extension decides what kind of cell holds its place. A tag the
 * host has no file for draws nothing at all: the path was the agent's way of handing a file over,
 * and where there is no file it is not a sentence the reader is owed. One the host answered for with
 * a type nothing here draws — a phone's HEIC, a camera's MKV — takes the file row that downloads it
 * rather than a cell that can never fill (`drawnCell`, ADR 0111).
 */
export function mediaItems(tags: MediaTagItem[], sources: MediaSources): MediaItem[] {
  const items: MediaItem[] = []
  for (const tag of tags) {
    const state = sources.get(tag.key)
    if (state?.status === "undrawable") continue
    const read = state?.status === "ready" ? state.read : undefined
    // A tag still being read has no type yet, and `drawnCell` reads the name it does have.
    const cell = drawnCell(read?.type, tag.path)
    items.push({
      key: tag.key,
      kind: mediaKind(read?.type, tag.path),
      cell,
      name: tag.name,
      type: read?.type ?? "",
      size: read?.size,
      path: tag.path,
      src: read?.url,
      state: mediaStage(state),
      note: state?.status === "failed" ? state.note : undefined,
    })
  }
  return items
}
