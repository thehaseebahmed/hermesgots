import type { MediaItem } from "@/components/chat/media-gallery"
import { mediaCell, mediaKind } from "./media-kind.ts"
import type { MediaSources } from "./media-source.ts"

/** A reply's `MEDIA:<path>` tag as it was written: where the file lies, and the name to draw it by. */
export interface MediaTagItem {
  key: string
  path: string
  name: string
}

export interface TaggedMedia {
  /** What the thread draws, in the order the tags were written: a cell, a recording, or a file row. */
  items: MediaItem[]
  /** Tags the host had nothing for, drawn as the text they came from. */
  unread: { key: string; path: string }[]
}

/**
 * A reply's tags as the thread draws them, from what the host answered for each — a tag still being
 * read carries no bytes yet, and its extension decides what kind of cell holds its place.
 */
export function mediaItems(tags: MediaTagItem[], sources: MediaSources): TaggedMedia {
  const items: MediaItem[] = []
  const unread: TaggedMedia["unread"] = []
  for (const tag of tags) {
    const state = sources.get(tag.key)
    if (state?.status === "empty") {
      unread.push({ key: tag.key, path: tag.path })
      continue
    }
    const read = state?.status === "ready" ? state.read : undefined
    items.push({
      key: tag.key,
      kind: mediaKind(read?.type, tag.path),
      cell: mediaCell(read?.type, tag.path),
      name: tag.name,
      type: read?.type ?? "",
      size: read?.size,
      src: read?.url,
    })
  }
  return { items, unread }
}
