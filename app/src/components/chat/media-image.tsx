import { Cell, MediaItems, type MediaItem } from "@/components/chat/media-gallery"
import { downloadAttachment } from "@/lib/attachments"
import { fileNameOf } from "@/lib/media-kind"
import { mediaItems } from "@/lib/media-items"
import { useMediaSources } from "@/lib/media-source"

/** An image written into a reply's Markdown: the Gallery's own cell, so it reads like a sent photo. */
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

/** The media behind the `MEDIA:<path>` tags a reply's part carries, through the thread's own cells. */
export function MediaTag({ conversationId, paths }: { conversationId: string; paths: string[] }) {
  // The same path may be named twice, so a tag is keyed by where it was written; the read behind it
  // is by path, shared across the thread.
  const tagged = paths.map((path, at) => ({ key: `${at}:${path}`, path, name: fileNameOf(path) }))
  const sources = useMediaSources(
    conversationId,
    tagged.map((tag) => ({ key: tag.key, path: tag.path })),
  )
  const { items, unread } = mediaItems(tagged, sources)
  const byKey = new Map(tagged.map((tag) => [tag.key, tag]))
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
  return (
    <div className="flex w-full max-w-[min(100%,42rem)] flex-col items-start gap-2">
      <MediaItems items={items} align="start" onDownload={download} />
      {unread.map((one) => (
        <Tag key={one.key} path={one.path} />
      ))}
    </div>
  )
}
