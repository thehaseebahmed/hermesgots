import { Cell, MediaItems, type MediaItem } from "@/components/chat/media-gallery"
import { usePreviewer } from "@/components/chat/previewer"
import { openAttachment } from "@/lib/attachments"
import { fileNameOf } from "@/lib/media-kind"
import { mediaItems, previewItem } from "@/lib/media-items"
import { useMediaSources } from "@/lib/media-source"
import { cn } from "@/lib/utils"

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

const tagKey = (path: string, at: number) => `${at}:${path}`

/**
 * The media behind a reply's `MEDIA:<path>` tags, drawn as the thread draws any media. A tag is how
 * the agent hands a file over, not something the reader is told: one the host has no file for draws
 * nothing at all, and a part with nothing left to draw is no part (ADR 0111). `className` is the
 * part's own edge, so what does draw stands where the tag was written.
 */
export function MediaTag({
  conversationId,
  paths,
  className,
}: {
  conversationId: string
  paths: string[]
  className?: string
}) {
  // The same path may be named twice, so a tag is keyed by where it was written; the URL behind it
  // is by path, shared across the thread.
  const tagged = paths.map((path, at) => ({ key: tagKey(path, at), path, name: fileNameOf(path) }))
  const { states, retry, renew, server } = useMediaSources(
    conversationId,
    tagged.map((tag) => ({ key: tag.key, path: tag.path })),
  )
  const items = mediaItems(tagged, states)
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
  if (!items.length) return null
  return (
    <div
      className={cn("flex w-full max-w-[min(100%,42rem)] flex-col items-start gap-2", className)}
    >
      <MediaItems
        items={items}
        server={server}
        align="start"
        onDownload={download}
        onRetry={(one) => retry(one.key)}
        onRefresh={(one) => renew(one.key)}
      />
    </div>
  )
}
