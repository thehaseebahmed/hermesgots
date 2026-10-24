import { useEffect, useState } from "react"

import { toast } from "sonner"

import { AttachmentTile } from "@/components/chat/attachments"
import { AudioRow, CELL, MediaGallery, type MediaItem } from "@/components/chat/media-gallery"
import { Skeleton } from "@/components/ui/skeleton"
import { downloadAttachment } from "@/lib/attachments"
import type { Attachment } from "@/lib/db"
import { useImageReady } from "@/lib/image"
import { fileNameOf, mediaCell, mediaKind, type MediaCell } from "@/lib/media-kind"
import { loadMediaFile, type MediaFile } from "@/lib/media-tags"
import { openImageViewer } from "@/lib/native"
import { cn } from "@/lib/utils"

/** An image in a reply; tapping it opens the larger view. */
export function MediaImage({ src, alt }: { src: string; alt?: string }) {
  // The image reserves its place through the skeleton, and the real one loads behind it: `src` is
  // already set, so an <img> that isn't displayed yet still fetches, decodes and fires `load`.
  const { ready, onLoad, onError } = useImageReady(src)
  return (
    <button
      type="button"
      onClick={() => void openImageViewer(src)}
      aria-label={alt || "Open image"}
      aria-busy={!ready || undefined}
      className={cn(CELL, "relative block cursor-pointer overflow-hidden bg-muted/40")}
    >
      {!ready && <Skeleton className="absolute inset-0 rounded-xl" />}
      <img
        src={src}
        alt={alt ?? ""}
        onLoad={onLoad}
        onError={onError}
        className={cn("h-full w-full object-cover", !ready && "invisible")}
        draggable={false}
      />
    </button>
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

/** One tag, once the host has answered for it — or not yet, or not at all. */
interface Tagged {
  /** This tag's place in its part: the same path may be named twice. */
  key: string
  path: string
  name: string
  /** The file the host answered with: `undefined` while it is still being read, `null` if it can't. */
  file?: MediaFile | null
  cell: MediaCell
  item: MediaItem
}

/**
 * The media behind a reply's `MEDIA:<path>` tags, drawn through the thread's own cells: the images
 * and clips take one Gallery — a group of tags sent together is one Gallery, its cells in the order
 * they were written — each recording a row of its own, and every other file a row that downloads it,
 * drawn in that order, and any tag the host can't answer last, as the text it came from. What each
 * file is comes from what the host answered, read through `mediaCell`, so a reply reads exactly like
 * a message the user sent. A tag still being read holds its place — a cell where its extension says
 * media, a row for the rest.
 */
export function MediaTag({ conversationId, paths }: { conversationId: string; paths: string[] }) {
  // The list's identity moves on every render (it comes from splitting a streaming reply), so the
  // join keys the read below.
  const joined = paths.join("\n")
  const list = joined.split("\n")
  // By path, so a reply that grows while it streams keeps the files it has; `null` is one the host
  // couldn't answer, and no entry at all is one still being read.
  const [read, setRead] = useState<Map<string, MediaFile | null>>(new Map())
  useEffect(() => {
    let stale = false
    const asked = joined.split("\n")
    void Promise.all(asked.map((path) => loadMediaFile(conversationId, path))).then((answers) => {
      if (!stale) setRead(new Map(asked.map((path, i) => [path, answers[i]])))
    })
    return () => {
      stale = true
    }
  }, [conversationId, joined])

  const tagged: Tagged[] = list.map((path, at) => {
    const file = read.get(path)
    const name = fileNameOf(path)
    return {
      key: `${at}:${path}`,
      path,
      name,
      file,
      cell: mediaCell(file?.type ?? "", path),
      item: {
        key: `${at}:${path}`,
        kind: mediaKind(file?.type, path),
        name,
        type: file?.type ?? "",
        size: file?.size,
        src: file?.url,
      },
    }
  })
  // The file as the row that downloads it draws it, saved under the name the tag gave.
  const asAttachment = (tag: Tagged): Attachment => ({
    id: tag.path,
    name: tag.name,
    type: tag.file?.type ?? "",
    size: tag.file?.size ?? 0,
    image: false,
    path: tag.path,
  })
  const download = (tag: Tagged) =>
    void downloadAttachment(conversationId, asAttachment(tag)).catch(() => {
      toast.error(`Couldn't download ${tag.name}.`)
    })
  const drawn = tagged.filter((tag) => tag.file !== null)
  const unread = tagged.filter((tag) => tag.file === null)
  return (
    <div className="flex w-full max-w-[min(100%,42rem)] flex-col items-start gap-2">
      <MediaGallery items={drawn.filter((tag) => tag.cell === "gallery").map((tag) => tag.item)} />
      {drawn
        .filter((tag) => tag.cell === "audio")
        .map((tag) => (
          <AudioRow key={tag.key} item={tag.item} />
        ))}
      {drawn
        .filter((tag) => tag.cell === "file")
        .map((tag) => (
          <AttachmentTile
            key={tag.key}
            attachment={asAttachment(tag)}
            action="download"
            onOpen={tag.file ? () => download(tag) : undefined}
          />
        ))}
      {unread.map((tag) => (
        <Tag key={tag.key} path={tag.path} />
      ))}
    </div>
  )
}
