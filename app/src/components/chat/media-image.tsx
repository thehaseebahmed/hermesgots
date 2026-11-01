import { Cell, MediaItems, type MediaItem } from "@/components/chat/media-gallery"
import { usePreviewer } from "@/components/chat/previewer"
import { openAttachment } from "@/lib/attachments"
import { fileNameOf } from "@/lib/media-kind"
import { mediaItems, previewItem } from "@/lib/media-items"
import { useMediaSources } from "@/lib/media-source"

/**
 * An image written into a reply's Markdown: the Gallery's own cell, so it reads like a sent photo,
 * and a tap opens the same Previewer on it — one picture, no stepping.
 */
export function MediaImage({ src, alt }: { src: string; alt?: string }) {
  const { open } = usePreviewer()
  const item: MediaItem = {
    key: src,
    kind: "image",
    cell: "gallery",
    name: alt || "image",
    type: "image/*",
    src,
    state: "ready",
  }
  return <Cell item={item} onOpen={() => open({ items: [previewItem(item)], index: 0 })} />
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
const tagKey = (path: string, at: number) => `${at}:${path}`

export function MediaTag({ conversationId, paths }: { conversationId: string; paths: string[] }) {
  // The same path may be named twice, so a tag is keyed by where it was written; the URL behind it
  // is by path, shared across the thread.
  const tagged = paths.map((path, at) => ({ key: tagKey(path, at), path, name: fileNameOf(path) }))
  const { states, retry, renew, server } = useMediaSources(
    conversationId,
    tagged.map((tag) => ({ key: tag.key, path: tag.path })),
  )
  const { items, unread } = mediaItems(tagged, states)
  const byKey = new Map(tagged.map((tag) => [tag.key, tag]))
  const download = (item: MediaItem) => {
    const tag = byKey.get(item.key)
    if (!tag) return
    void openAttachment(conversationId, {
      name: tag.name,
      type: item.type,
      path: tag.path,
      src: item.src,
    })
  }
  return (
    <div className="flex w-full max-w-[min(100%,42rem)] flex-col items-start gap-2">
      <MediaItems
        items={items}
        server={server}
        align="start"
        onDownload={download}
        onRetry={(one) => retry(one.key)}
        onRefresh={(one) => renew(one.key)}
      />
      {unread.map((one) => (
        <Tag key={one.key} path={one.path} />
      ))}
    </div>
  )
}
