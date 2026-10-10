import { useEffect, useState } from "react"

import { Popup, PopupContent } from "@/components/popup"
import { loadMediaImage } from "@/lib/media-tags"

/** An image in a reply; tapping it opens the larger view. */
export function MediaImage({ src, alt }: { src: string; alt?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={alt || "Open image"}
        className="block w-full max-w-[min(100%,42rem)] cursor-zoom-in overflow-hidden rounded-xl border bg-muted/40"
      >
        <img
          src={src}
          alt={alt ?? ""}
          className="max-h-[60dvh] w-full object-contain"
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

/** The image behind a reply's `MEDIA:<path>` tag, or the tag itself when it can't load. */
export function MediaTag({ conversationId, path }: { conversationId: string; path: string }) {
  const [url, setUrl] = useState<string | null>()
  useEffect(() => {
    let stale = false
    void loadMediaImage(conversationId, path).then((next) => {
      if (!stale) setUrl(next)
    })
    return () => {
      stale = true
    }
  }, [conversationId, path])
  if (url) return <MediaImage src={url} />
  if (url === null)
    return (
      <code className="w-fit rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-[0.85em] text-muted-foreground">
        MEDIA:{path}
      </code>
    )
  return null
}
