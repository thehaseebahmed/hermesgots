import type { MediaItem } from "@/components/chat/media-gallery"
import type { PreviewItem } from "@/components/chat/previewer"
import { drawnCell, mediaKind } from "./media-kind.ts"
import type { MediaSources } from "./media-source.ts"
import { mediaStage } from "./media-stage.ts"

/**
 * A file as the thread is told of it, before the host answers: where it lies, the name to draw it by,
 * and — where whoever wrote the tag already knew — what it is and how big. A `MEDIA:` tag names only
 * where the file lies; a room's row, whose manifest the Host answered with, knows the other two.
 */
export interface MediaTagItem {
  key: string
  path: string
  name: string
  /** The file's own type, where the tag's writer knew it: the host's answer still wins. */
  type?: string
  /** Its size, in the same way. */
  size?: number
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
 * A thread's files as it draws them, from what the host answered for each — a reply's `MEDIA:` tags,
 * or a room row's manifest — a file still being read carries no URL yet, and its type (or, where it
 * names none, its extension) decides what kind of cell holds its place. A file the host has no copy
 * of draws nothing at all: the path was the agent's way of handing it over, and where there is no
 * file it is not a sentence the reader is owed. One the host answered for with a type nothing here
 * draws — a phone's HEIC, a camera's MKV — takes the file row that downloads it rather than a cell
 * that can never fill (`drawnCell`, ADR 0111).
 */
export function mediaItems(tags: MediaTagItem[], sources: MediaSources): MediaItem[] {
  const items: MediaItem[] = []
  for (const tag of tags) {
    const state = sources.get(tag.key)
    if (state?.status === "undrawable") continue
    const read = state?.status === "ready" ? state.read : undefined
    // What the host said the file is, and where it said nothing yet, what the tag's writer knew:
    // a tag still being read has no type of its own beyond that, and `drawnCell` reads the name it
    // does have.
    const type = read?.type ?? tag.type ?? ""
    const cell = drawnCell(type, tag.path)
    items.push({
      key: tag.key,
      kind: mediaKind(type, tag.path),
      cell,
      name: tag.name,
      type,
      size: read?.size ?? tag.size,
      path: tag.path,
      src: read?.url,
      state: mediaStage(state),
      note: state?.status === "failed" ? state.note : undefined,
    })
  }
  return items
}
