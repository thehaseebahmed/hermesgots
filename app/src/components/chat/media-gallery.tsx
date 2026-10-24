import { useEffect, useState } from "react"
import { PlayIcon } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import type { MediaKind } from "@/lib/media-kind"
import { formatBytes } from "@/lib/attachment-caps"
import { useImageReady } from "@/lib/image"
import { openMediaViewer } from "@/lib/native"
import { cn } from "@/lib/utils"

// Every cell in the Gallery takes this box — a photo, and a clip's first frame — so nothing moves
// as media arrives. A reply's single image has always taken it, and still does.
export const CELL = "h-24 w-full rounded-xl border md:h-32 xl:h-40"

/**
 * One piece of media in a thread, as a Gallery cell or a row of its own: what it is, and where the
 * bytes are if they're in. A tap hands it to the platform's viewer or player — nothing plays here.
 */
export interface MediaItem {
  /** Stable where the item came from: an attachment's id, or a tag's path. */
  key: string
  kind: MediaKind
  name: string
  /** The file's own type, which is what the platform is asked to open. */
  type: string
  /** Its size, where the message kept one. */
  size?: number
  /** What to draw or play, once the bytes are in. */
  src?: string
}

/** How long the browser gets to give up a clip's first frame before its cell settles for less. */
const FRAME_TIMEOUT_MS = 4000

/**
 * A clip's first frame, from the browser's own metadata load: an element that is never put on the
 * page seeks a moment in and paints that frame to a canvas. A clip is never played in the thread,
 * so this is the one look at it there is; a browser that can't decode it answers nothing.
 */
async function firstFrame(src: string, type: string): Promise<string | null> {
  const video = document.createElement("video")
  // A type this browser can't play has no first frame to give, and asking would only wait.
  if (!video.canPlayType(type)) return null
  video.muted = true
  video.playsInline = true
  video.preload = "auto"
  video.src = src
  const settle = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("A clip that never loaded.")),
        FRAME_TIMEOUT_MS,
      )
      const done = () => {
        window.clearTimeout(timer)
        resolve()
      }
      const failed = () => {
        window.clearTimeout(timer)
        reject(new Error("A clip that can't be read."))
      }
      video.addEventListener(event, done, { once: true })
      video.addEventListener("error", failed, { once: true })
    })
  try {
    await settle("loadeddata")
    // The very first frame is often black; a moment in shows what the clip is about.
    if (Number.isFinite(video.duration) && video.duration > 0.1) {
      video.currentTime = 0.1
      await settle("seeked")
    }
    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext("2d")
    if (!context || !canvas.width || !canvas.height) return null
    context.drawImage(video, 0, 0)
    return canvas.toDataURL("image/jpeg", 0.8)
  } catch {
    return null
  } finally {
    // The element is off the page and done with: let go of the clip's bytes.
    video.removeAttribute("src")
    video.load()
  }
}

/**
 * The cell's frame and whether the attempt is over: a clip the browser cannot read settles with no
 * frame rather than pulsing a skeleton forever.
 */
function useFirstFrame(src: string | undefined, type: string) {
  const [frame, setFrame] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!src) return
    let stale = false
    void firstFrame(src, type).then((taken) => {
      if (stale) return
      setFrame(taken)
      setSettled(true)
    })
    return () => {
      stale = true
    }
  }, [src, type])
  return { frame, settled }
}

function open(item: MediaItem) {
  if (item.src) void openMediaViewer(item.src, { type: item.type, name: item.name })
}

/** A photo in its cell, holding the box with a skeleton until its bytes are drawn. */
function Picture({ src, alt }: { src?: string; alt: string }) {
  const { ready, onLoad, onError } = useImageReady(src ?? "")
  return (
    <>
      {(!src || !ready) && <Skeleton className="absolute inset-0 rounded-xl" />}
      {src && (
        <img
          src={src}
          alt={alt}
          onLoad={onLoad}
          onError={onError}
          className={cn("h-full w-full object-cover", !ready && "invisible")}
          draggable={false}
        />
      )}
    </>
  )
}

/** One cell: a photo, or the first frame of a clip with the mark that it is one. */
function Cell({ item }: { item: MediaItem }) {
  const clip = item.kind === "video"
  const { frame, settled } = useFirstFrame(clip ? item.src : undefined, item.type ?? "")
  return (
    <button
      type="button"
      onClick={() => open(item)}
      disabled={!item.src}
      aria-label={`Open ${item.name}`}
      aria-busy={!item.src || undefined}
      className={cn(CELL, "relative block cursor-pointer overflow-hidden bg-muted/40")}
    >
      {clip ? (
        <>
          {frame ? (
            <img
              src={frame}
              alt={`First frame of ${item.name}`}
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : settled ? null : (
            <Skeleton className="absolute inset-0 rounded-xl" />
          )}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white">
              <PlayIcon className="size-4" />
            </span>
          </span>
        </>
      ) : (
        <Picture src={item.src} alt={item.name} />
      )}
    </button>
  )
}

/**
 * The Gallery: a message's images and clips side by side, one cell each, whatever device the
 * message is read on. Nothing is embedded — a cell is a picture and a tap.
 */
export function MediaGallery({
  items,
  align = "start",
}: {
  items: MediaItem[]
  /** Which edge the cells hug: a reply's start, a message the user sent the end, beside its bubble. */
  align?: "start" | "end"
}) {
  if (!items.length) return null
  const columns = items.length >= 5 ? 3 : 2
  // A cell is a share of the row, whatever the row is, so a message's cells and a reply's are the
  // same size and a lone cell sits on its own side instead of a whole empty column away.
  const width = columns === 3 ? "w-[calc((100%_-_1rem)/3)]" : "w-[calc((100%_-_0.5rem)/2)]"
  return (
    <div
      role="group"
      aria-label="Gallery"
      className={cn(
        "flex w-full max-w-[min(100%,42rem)] flex-wrap gap-2",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {items.map((item) => (
        <div key={item.key} className={width}>
          <Cell item={item} />
        </div>
      ))}
    </div>
  )
}

/**
 * A recording in the thread: a row of its own, never a cell in the Gallery, and a tap hands it to
 * the platform's player.
 */
export function AudioRow({ item }: { item: MediaItem }) {
  return (
    <button
      type="button"
      onClick={() => open(item)}
      disabled={!item.src}
      aria-label={`Play ${item.name}`}
      aria-busy={!item.src || undefined}
      className="flex w-full max-w-[min(100%,42rem)] items-center gap-3 rounded-xl border bg-muted/40 px-3 py-2.5 text-left text-sm"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
        <PlayIcon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="line-clamp-1 break-all">{item.name}</span>
        {item.size ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(item.size)}
          </span>
        ) : null}
      </span>
    </button>
  )
}
