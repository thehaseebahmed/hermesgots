import { useEffect, useId, useRef, useState } from "react"
import { PlayIcon, RotateCwIcon } from "lucide-react"

import { FileRow, MediaName } from "@/components/chat/attachments"
import { usePreviewer } from "@/components/chat/previewer"
import { Skeleton } from "@/components/ui/skeleton"
import { boundedStore } from "@/lib/bounded-cache"
import { cachedFrame, rememberFrame, rememberMedia } from "@/lib/media-cache"
import { previewItem } from "@/lib/media-items"
import type { MediaStage } from "@/lib/media-stage"
import type { MediaCell, MediaKind } from "@/lib/media-kind"
import { quietly } from "@/lib/report"
import { cn } from "@/lib/utils"

// Every cell in the Gallery takes this box — a photo, and a clip's first frame — so nothing moves
// as media arrives. A reply's single image has always taken it, and still does.
const CELL = "h-24 w-full rounded-xl border md:h-32 xl:h-40"

/** How far a file's bytes are in, as the cell that keeps its place draws them. */
export type MediaItemState = MediaStage

/** One piece of media a thread draws: what it is, where it draws, and where it is read from. */
export interface MediaItem {
  /** Stable where the item came from: an attachment's id, or the index a tag was written at. */
  key: string
  kind: MediaKind
  /** Where it draws — worked out once, where the item is made, from what it is. */
  cell: MediaCell
  name: string
  /** The file's own type, which is what the platform is asked to open. */
  type: string
  /** Its size, where the message kept one. */
  size?: number
  /** Where the file lies on the host, which is what the frame this device keeps for a clip is keyed by. */
  path?: string
  /** The URL the host signed for it, once its answer is in. */
  src?: string
  state: MediaItemState
  /** What the host answered when it refused the file — its name and the cap it met. */
  note?: string
}

/** How long the browser gets to give up a clip's first frame before its cell settles for less. */
const FRAME_TIMEOUT_MS = 4000

/** Clips whose bytes the browser couldn't read, by the URL that was tried: a new URL is a new try. */
const UNREADABLE_LIMIT = 64
const unreadable = boundedStore<true>({ limit: UNREADABLE_LIMIT })

/**
 * Waits for the clip to give up a frame of its own: a recorded clip reports no size until one is
 * decoded, and a frame callback is the one thing that says it has been.
 */
const nextFrame = (video: HTMLVideoElement) =>
  new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(done, FRAME_TIMEOUT_MS)
    video.addEventListener("resize", done, { once: true })
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(done)
  })

/**
 * A clip's first frame, painted by an element that is never put on the page: it loads the clip,
 * seeks a moment in and draws that to a canvas. A clip is never played in the thread, so painting is
 * the only look at it, and what it paints is the caller's to keep.
 */
async function paintFrame(src: string, type: string): Promise<Blob | null> {
  const video = document.createElement("video")
  let frame: Blob | null = null
  // A type this browser can't play has no first frame to give, and asking would only wait.
  if (video.canPlayType(type)) {
    video.muted = true
    video.playsInline = true
    video.preload = "auto"
    // The clip comes from the bot's host, not this page's origin: without CORS the frame it paints
    // is a tainted canvas, and a tainted canvas can't be read back into the cell.
    video.crossOrigin = "anonymous"
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
      // A clip the page recorded names its own size a moment after its first frame, so the canvas
      // waits for a frame rather than drawing an empty one.
      if (!video.videoWidth) await nextFrame(video)
      const canvas = document.createElement("canvas")
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext("2d")
      if (context && canvas.width && canvas.height) {
        context.drawImage(video, 0, 0)
        frame = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.8),
        )
      }
    } catch {
      frame = null
    } finally {
      // The element is off the page and done with: let go of the clip's bytes.
      video.removeAttribute("src")
      video.load()
    }
  }
  return frame
}

/**
 * The frame a clip's cell draws: the one this device kept of it — no clip, no URL, and the same
 * frame with the host away — or a look at the clip itself, painted once and then kept. A paint that
 * comes to nothing is remembered against the URL that failed, so a URL that has run out is not
 * tried again and one minted after it is: for a clip that is the whole repair path, since its cell
 * has no picture of its own to fail.
 */
async function frameOf(server: string, path: string, src: string | undefined, type: string) {
  const kept = await cachedFrame(server, path)
  if (kept) return kept.url
  if (!src || unreadable.has(src)) return null
  const painted = await paintFrame(src, type)
  if (!painted) {
    unreadable.set(src, true)
    return null
  }
  return rememberFrame(server, path, painted)
}

/**
 * A clip's cell: the frame, and whether the attempt is over. A clip the browser cannot read settles
 * with no frame rather than pulsing a skeleton forever, and only a clip asks at all.
 */
function useFirstFrame(item: MediaItem, server: string | undefined) {
  const wants = item.kind === "video"
  const { path, src, type } = item
  const [frame, setFrame] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!wants || !server || !path) return
    let stale = false
    void frameOf(server, path, src, type).then((taken) => {
      if (stale) return
      setFrame(taken)
      setSettled(true)
    })
    return () => {
      stale = true
    }
  }, [wants, server, path, src, type])
  return { frame, settled }
}

/** A photo in its cell, holding the box with a skeleton until its bytes are drawn. */
function Picture({
  src,
  alt,
  onStale,
  onPainted,
}: {
  src?: string
  alt: string
  /** Says the load didn't come, which may only be that the URL in it has run out. */
  onStale?: () => void
  /** Says the picture is on screen, which is the one moment it is worth keeping. */
  onPainted?: () => void
}) {
  // Three faces, not two: a photo the browser couldn't decode keeps its place and says so, rather
  // than leaving a broken element in a cell that looks drawn.
  const [face, setFace] = useState<"reading" | "ready" | "failed">("reading")
  const [shown, setShown] = useState(src)
  if (shown !== src) {
    setShown(src)
    setFace("reading")
  }
  return (
    <>
      {/* The cell's own box, the border included: a placeholder that stopped inside it would be a
          couple of pixels short of the cell the image lands in. */}
      {(!src || face === "reading") && <Skeleton className="absolute -inset-px rounded-xl" />}
      {src && face !== "failed" && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => {
            setFace("ready")
            onPainted?.()
          }}
          onError={() => {
            setFace("failed")
            onStale?.()
          }}
          className={cn("h-full w-full object-cover", face !== "ready" && "invisible")}
          draggable={false}
        />
      )}
      {face === "failed" && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
          <RotateCwIcon className="size-5" />
          <span>Couldn't load</span>
        </span>
      )}
    </>
  )
}

/**
 * One cell: a photo, or the first frame of a clip with the mark that it is one. Its place is kept
 * whatever its bytes are doing — a skeleton while its URL is out, a plain face with a retry when the
 * read failed — and a tap opens the app's Previewer, never leaves for another app.
 */
export function Cell({
  item,
  server,
  onOpen,
  onRefresh,
  onPainted,
}: {
  item: MediaItem
  /** The bot's own address, which is what a copy this device keeps of its files is keyed by. */
  server?: string
  onOpen?: () => void
  /** Asks for another URL, when the one this cell drew from has run out. */
  onRefresh?: () => void
  /** Says a picture has been drawn here, which is when it is worth keeping. */
  onPainted?: () => void
}) {
  const clip = item.kind === "video"
  const { frame, settled } = useFirstFrame(item, server)
  // A clip has no `<img>` to fail on: a frame that came to nothing is its version of one.
  useEffect(() => {
    if (!clip || !settled || frame || !item.src) return
    onRefresh?.()
  }, [clip, settled, frame, item.src, onRefresh])
  const failed = item.state === "failed"
  const badge = (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-foreground/55 text-background">
        <PlayIcon className="size-4" />
      </span>
    </span>
  )
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${item.name}`}
      aria-busy={item.state === "reading" || undefined}
      className={cn(CELL, "relative block cursor-pointer overflow-hidden bg-muted/40")}
    >
      {clip ? (
        <>
          {/* A frame this device kept outlives the URL it was painted for: it is drawn even where
              the clip's own URL never came, which is a cell with a picture and no player. */}
          {frame ? (
            <img
              src={frame}
              alt={`First frame of ${item.name}`}
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : failed ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <RotateCwIcon className="size-6 text-muted-foreground" />
            </span>
          ) : settled ? null : (
            <Skeleton className="absolute -inset-px rounded-xl" />
          )}
          {badge}
        </>
      ) : failed ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <RotateCwIcon className="size-6 text-muted-foreground" />
        </span>
      ) : (
        <Picture src={item.src} alt={item.name} onStale={onRefresh} onPainted={onPainted} />
      )}
    </button>
  )
}

/** A message's images and clips side by side, one cell each: a cell is a picture and a tap. */
function MediaGallery({
  items,
  server,
  align = "start",
  onOpen,
  onRefresh,
  onPainted,
}: {
  items: MediaItem[]
  /** The bot this thread's files belong to, as `Cell` takes it. */
  server?: string
  /** Which edge the cells hug: a reply's start, a message the user sent the end, beside its bubble. */
  align?: "start" | "end"
  /** Opens the Previewer on one of them. */
  onOpen: (item: MediaItem) => void
  /** Asks for another URL for one whose own has run out. */
  onRefresh?: (item: MediaItem) => void
  /** Says a picture was drawn, for the one that is worth keeping. */
  onPainted?: (item: MediaItem) => void
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
          <Cell
            item={item}
            server={server}
            onOpen={() => onOpen(item)}
            onRefresh={onRefresh ? () => onRefresh(item) : undefined}
            onPainted={onPainted ? () => onPainted(item) : undefined}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * A recording in the thread: a row of its own, never a cell in the Gallery, and a tap opens the
 * Previewer on it, where it plays.
 */
function AudioRow({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Play ${item.name}`}
      aria-busy={item.state === "reading" || undefined}
      className="flex w-full max-w-[min(100%,42rem)] items-center gap-3 rounded-xl border bg-muted/40 px-3 py-2.5 text-left text-sm"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
        {item.state === "failed" ? (
          <RotateCwIcon className="size-4" />
        ) : (
          <PlayIcon className="size-4" />
        )}
      </span>
      <MediaName name={item.name} size={item.size} />
    </button>
  )
}

/**
 * A thread's media drawn in one place, wherever it came from: a cell, a recording's row, or a file's.
 * The cells and rows a tap opens the Previewer on are one list, in the order they are drawn here, so
 * stepping inside the Previewer follows the message.
 */
export function MediaItems({
  items,
  server,
  align = "start",
  onDownload,
  onRetry,
  onRefresh,
}: {
  items: MediaItem[]
  /** The bot's own address, which is what a copy this device keeps of its files is keyed by. */
  server?: string
  /** Which edge the cells and rows hug, as the Gallery takes it. */
  align?: "start" | "end"
  /** Hands a file that a tap can't show to the platform, which shows or saves it. */
  onDownload: (item: MediaItem) => void
  /** Asks a file whose read failed again. */
  onRetry?: (item: MediaItem) => void
  /** Asks for another URL for a cell drawing from one that has run out. */
  onRefresh?: (item: MediaItem) => void
}) {
  const { open: preview, update } = usePreviewer()
  const owner = useId()
  // A photo this device has just drawn is worth keeping: the next look at it needs no URL and no
  // host (ADR 0075). A clip is kept by its frame instead, where the frame is painted.
  const painted = (item: MediaItem) => {
    if (!server || !item.path || !item.src) return
    void rememberMedia(server, item.path, {
      url: item.src,
      type: item.type,
      size: item.size ?? 0,
    }).catch(quietly("keeping a copy of a drawn photo"))
  }
  const cells = items.filter((item) => item.cell === "gallery")
  const recordings = items.filter((item) => item.cell === "audio")
  const files = items.filter((item) => item.cell === "file")
  const playable = [...cells, ...recordings]
  // What the Previewer draws changes as each URL comes in, so the list it was opened on is kept
  // current rather than frozen at the tap: the signature says when something in it moved.
  const signature = playable.map((one) => `${one.key}\u0000${one.state}\u0000${one.src}`).join("\n")
  const live = useRef(playable)
  useEffect(() => {
    live.current = playable
  })
  useEffect(() => {
    update(
      owner,
      live.current.map((one) => previewItem(one)),
    )
  }, [owner, signature, update])
  const open = (item: MediaItem) =>
    preview(
      {
        items: playable.map((one) => previewItem(one)),
        index: playable.indexOf(item),
        onRetry:
          onRetry &&
          ((shown) => {
            const found = items.find((one) => one.key === shown.key)
            if (found) onRetry(found)
          }),
      },
      owner,
    )
  return (
    <>
      <MediaGallery
        items={cells}
        server={server}
        align={align}
        onOpen={open}
        onRefresh={onRefresh}
        onPainted={painted}
      />
      {recordings.map((item) => (
        <AudioRow key={item.key} item={item} onOpen={() => open(item)} />
      ))}
      {files.length > 0 && (
        <div
          className={cn(
            "flex max-w-full flex-wrap gap-2",
            align === "end" ? "justify-end" : "justify-start",
          )}
        >
          {files.map((item) => (
            <FileRow
              key={item.key}
              name={item.name}
              size={item.size}
              onSave={() => onDownload(item)}
            />
          ))}
        </div>
      )}
    </>
  )
}
