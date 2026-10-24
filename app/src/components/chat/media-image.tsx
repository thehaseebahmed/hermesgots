import { Cell, MediaItems, type MediaItem } from "@/components/chat/media-gallery"
import { downloadAttachment } from "@/lib/attachments"
import { fileNameOf, mediaCell, mediaKind } from "@/lib/media-kind"
import { useMediaSources } from "@/lib/media-source"

/**
 * An image in a reply: the Gallery's own cell, so a reply's image and a message's read alike, and a
 * tap opens the larger view.
 */
export function MediaImage({ src, alt }: { src: string; alt?: string }) {
  return (
    <Cell
      item={{
        key: src,
        kind: "image",
        cell: "gallery",
        name: alt || "image",
        type: "image/*",
        src,
      }}
    />
  )
}

/** A `MEDIA:<path>` tag kept visible as text, because the file behind it can't be read. */
function Tag({ path }: { path: string }) {
  return (
    <code className="w-fit rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-[0.85em] text-muted-foreground">
      MEDIA:{path}
    </code>
  )
}

/**
 * The media behind a reply's `MEDIA:<path>` tags, drawn through the thread's own cells: the images
 * and clips take one Gallery — a group of tags sent together is one Gallery, its cells in the order
 * they were written — each recording a row of its own, and every other file a row that saves it,
 * drawn in that order, and any tag the host can't answer last, as the text it came from. What each
 * file is comes from what the host answered, so a reply reads exactly like a message the user sent.
 * A tag still being read holds its place — a cell where its extension says media, a row for the rest
 * — and a row's tap saves the file as soon as the shared read has it.
 */
export function MediaTag({ conversationId, paths }: { conversationId: string; paths: string[] }) {
  // The same path may be named twice, so a tag is keyed by where it was written; the read behind it
  // is by path, shared across the thread.
  const tagged = paths.map((path, at) => ({ key: `${at}:${path}`, path, name: fileNameOf(path) }))
  const sources = useMediaSources(
    conversationId,
    tagged.map((tag) => ({ key: tag.key, path: tag.path })),
  )
  const items = tagged.map((tag) => {
    const read = sources.get(tag.key)
    return {
      tag,
      read,
      item: {
        key: tag.key,
        kind: mediaKind(read?.type, tag.path),
        cell: mediaCell(read?.type, tag.path),
        name: tag.name,
        type: read?.type ?? "",
        size: read?.size,
        src: read?.url,
      } satisfies MediaItem,
    }
  })
  const byKey = new Map(tagged.map((tag) => [tag.key, tag]))
  // The file as the row that saves it draws it: saved under the name the tag gave, from the path
  // the host holds it at.
  const download = (item: MediaItem) => {
    const tag = byKey.get(item.key)
    if (!tag) return
    void downloadAttachment(conversationId, {
      id: tag.path,
      name: tag.name,
      type: item.type,
      size: item.size ?? 0,
      image: false,
      path: tag.path,
    })
  }
  const drawn = items.filter((one) => one.read !== null)
  const unread = items.filter((one) => one.read === null)
  return (
    <div className="flex w-full max-w-[min(100%,42rem)] flex-col items-start gap-2">
      <MediaItems items={drawn.map((one) => one.item)} align="start" onDownload={download} />
      {unread.map((one) => (
        <Tag key={one.item.key} path={one.tag.path} />
      ))}
    </div>
  )
}
