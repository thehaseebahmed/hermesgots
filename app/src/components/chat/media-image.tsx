import { useEffect, useState } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import { useImageReady } from "@/lib/image"
import { loadMediaImage } from "@/lib/media-tags"
import { openImageViewer } from "@/lib/native"
import { cn } from "@/lib/utils"

// Every image in a reply takes this cell — one image alone, a gallery of them, or one written into
// the reply's own Markdown — and its skeleton takes it too, so nothing moves as it arrives.
const CELL = "h-24 w-full rounded-xl border md:h-32 xl:h-40"

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

/** A `MEDIA:<path>` tag kept visible as text, because the image behind it can't load. */
function Tag({ path }: { path: string }) {
  return (
    <code className="w-fit rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-[0.85em] text-muted-foreground">
      MEDIA:{path}
    </code>
  )
}

/**
 * The images behind a reply's `MEDIA:<path>` tags, one or several sent together, each in the same
 * cell: one image is one cell, which is exactly what a gallery's images are. An image still being
 * read holds its cell with a skeleton; a tag that can't load stays visible as its text.
 */
export function MediaTag({ conversationId, paths }: { conversationId: string; paths: string[] }) {
  // The list's identity moves on every render (it comes from splitting a streaming reply), so the
  // join keys the fetch below.
  const joined = paths.join("\n")
  const list = joined.split("\n")
  // By path, so a reply that grows while it streams keeps the images it has, and a new tag is
  // loading, not shown as text, until its read is in.
  const [loaded, setLoaded] = useState<Map<string, string | null>>(new Map())
  useEffect(() => {
    let stale = false
    const paths = joined.split("\n")
    void Promise.all(paths.map((path) => loadMediaImage(conversationId, path))).then((next) => {
      if (!stale) setLoaded(new Map(paths.map((path, i) => [path, next[i]])))
    })
    return () => {
      stale = true
    }
  }, [conversationId, joined])
  return (
    <div
      className={cn(
        "grid w-full max-w-[min(100%,42rem)] gap-2",
        list.length >= 5 ? "grid-cols-3" : "grid-cols-2",
      )}
    >
      {list.map((path, i) => {
        const url = loaded.get(path)
        if (url === undefined) return <Skeleton key={i} className={CELL} />
        return url ? <MediaImage key={i} src={url} /> : <Tag key={i} path={path} />
      })}
    </div>
  )
}
