import { useEffect, useState } from "react"

import { Popup, PopupContent } from "@/components/popup"
import { loadMediaImage } from "@/lib/media-tags"
import { useWide } from "@/lib/media"
import { openImageViewer } from "@/lib/native"
import { cn } from "@/lib/utils"

/** An image in a reply; tapping it opens the larger view. `cell` sizes it for a gallery grid. */
export function MediaImage({ src, alt, cell }: { src: string; alt?: string; cell?: boolean }) {
  const [open, setOpen] = useState(false)
  const wide = useWide()
  return (
    <>
      <button
        type="button"
        onClick={() => (wide ? setOpen(true) : void openImageViewer(src))}
        aria-label={alt || "Open image"}
        className={cn(
          "block cursor-zoom-in overflow-hidden rounded-xl border bg-muted/40",
          cell ? "h-[120px] w-full md:h-[160px] xl:h-[200px]" : "w-fit max-w-[min(100%,42rem)]",
        )}
      >
        <img
          src={src}
          alt={alt ?? ""}
          className={
            cell
              ? "h-full w-full object-cover"
              : "max-h-[240px] w-auto max-w-full object-contain md:max-h-[320px] xl:max-h-[400px]"
          }
          draggable={false}
        />
      </button>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent className="max-w-2xl">
          <img
            src={src}
            alt={alt ?? ""}
            className="mx-auto max-h-[75dvh] w-auto max-w-full object-contain"
            draggable={false}
          />
        </PopupContent>
      </Popup>
    </>
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
 * The images behind a reply's `MEDIA:<path>` tags: one image, or the tags it sent together as a
 * small gallery. A tag that can't load stays visible as its text.
 */
export function MediaTag({ conversationId, paths }: { conversationId: string; paths: string[] }) {
  // The list's identity moves on every render (it comes from splitting a streaming reply), so the
  // join keys the fetch below.
  const joined = paths.join("\n")
  const list = joined.split("\n")
  const [urls, setUrls] = useState<(string | null)[] | null>()
  useEffect(() => {
    let stale = false
    void Promise.all(joined.split("\n").map((path) => loadMediaImage(conversationId, path))).then(
      (next) => {
        if (!stale) setUrls(next)
      },
    )
    return () => {
      stale = true
    }
  }, [conversationId, joined])
  if (!urls) return null
  if (list.length === 1) {
    const url = urls[0]
    return url ? <MediaImage src={url} /> : <Tag path={list[0]} />
  }
  return (
    <div
      className={cn(
        "grid w-full max-w-[min(100%,42rem)] gap-2",
        list.length >= 5 ? "grid-cols-3" : "grid-cols-2",
      )}
    >
      {list.map((path, i) => {
        const url = urls[i]
        return url ? <MediaImage key={i} src={url} cell /> : <Tag key={i} path={path} />
      })}
    </div>
  )
}
