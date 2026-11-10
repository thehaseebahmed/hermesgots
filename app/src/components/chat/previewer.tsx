import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  RotateCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { FullscreenPopup, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes } from "@/lib/attachment-caps"
import { openAttachment } from "@/lib/attachments"
import { useImageReady } from "@/lib/image"
import type { MediaKind } from "@/lib/media-kind"
import type { MediaStage } from "@/lib/media-stage"
import { ask } from "@/lib/net-watch"
import { readPage, type PageRead } from "@/lib/page-read"
import { previewerPage } from "@/lib/sandboxed-document"
import { cn } from "@/lib/utils"
import {
  UNZOOMED,
  zoomDragged,
  zoomPinched,
  zoomSettled,
  zoomTapped,
  type Pinch,
  type Frame,
  type ZoomPoint,
  type ZoomView,
} from "@/lib/zoom"

/** One piece of media the Previewer can draw: a photo, a clip, a recording or a page. */
export interface PreviewItem {
  /** Stable within the message: an attachment's id, or the place a tag was written at. */
  key: string
  name: string
  /** The file's own type, which is what the player is told it is. */
  type: string
  size?: number
  kind: Extract<MediaKind, "image" | "video" | "audio" | "page">
  /** Where it is read from, once the host has answered; a staged file's own bytes before that. */
  src?: string
  /**
   * A page's folder on the host, where its own stylesheets, scripts and images are loaded from
   * (ADR 0135). A staged page isn't on the host yet, so it has none and draws without them.
   */
  folder?: string
  state: MediaStage
  /** What the host said when it refused the file, drawn beside the retry. */
  note?: string
  /** A photo's own shape, where the record keeps it, so its box is right from the first frame. */
  width?: number
  height?: number
}

/** A list of media, the one on screen, and what the one who opened it allows. */
export interface PreviewRequest {
  items: PreviewItem[]
  index: number
  /** Takes a staged file off the message: the composer passes it, the thread does not. */
  onRemove?: (item: PreviewItem) => void
  /** Asks a file whose read failed again, and draws what answers. */
  onRetry?: (item: PreviewItem) => void
}

/** What a screen can ask of its one Previewer: open it, and keep the list it was opened on current. */
interface PreviewerFace {
  /** Opens the Previewer on this list of media, at this one. `owner` is the list's own name. */
  open: (request: PreviewRequest, owner?: string) => void
  /** Draws this owner's list as it is now: a URL that arrives while the Previewer is open lands. */
  update: (owner: string, items: PreviewItem[]) => void
}

const PreviewerContext = createContext<PreviewerFace | null>(null)

/** Whether a screen above this point already mounts the one Previewer a tap reaches. */
const PreviewerAbove = createContext(false)

/**
 * The one Previewer a screen mounts, and the way any tap on media reaches it: a Gallery cell, a
 * recording's row, an agent's image and a composer's tile all open this instance rather than one
 * of their own. Outside a screen that mounts it — a test of a part, the dev thread — a tap is inert.
 */
export function PreviewerProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<(PreviewRequest & { owner: string }) | null>(null)
  // Kept while the pop-up animates out, so it doesn't empty first.
  const [last, setLast] = useState<(PreviewRequest & { owner: string }) | null>(null)
  if (shown && shown !== last) setLast(shown)
  const onIndex = useCallback(
    (index: number | null) =>
      setShown((current) => (index === null ? null : current && { ...current, index })),
    [],
  )
  const face = useMemo<PreviewerFace>(
    () => ({
      open: (request, owner = "") => setShown({ ...request, owner }),
      update: (owner, items) =>
        setShown((current) => (current?.owner === owner ? { ...current, items } : current)),
    }),
    [],
  )
  const current = shown ?? last
  return (
    <PreviewerAbove.Provider value={true}>
      <PreviewerContext.Provider value={face}>
        {children}
        {current && <Previewer request={current} open={shown !== null} onIndex={onIndex} />}
      </PreviewerContext.Provider>
    </PreviewerAbove.Provider>
  )
}

/** The face a part with no screen around it gets: a tap on media is inert, and nothing re-renders. */
const INERT: PreviewerFace = { open: () => {}, update: () => {} }

/** The screen's Previewer. */
export function usePreviewer(): PreviewerFace {
  return useContext(PreviewerContext) ?? INERT
}

/**
 * Whether something above already mounts the Previewer a tap reaches: a part that brings its own so
 * its taps can't be inert asks this first, and joins the screen's instead of nesting a second one
 * the screen's own controls could never reach.
 */
export function usePreviewerAbove(): boolean {
  return useContext(PreviewerAbove)
}

/**
 * A photo at its own shape — the record's where it keeps one, the file's own once it lands — so the
 * box it reports through `frame` is the picture's own, which is what a drag may reach.
 */
function Picture({
  item,
  frame,
  onBroken,
}: {
  item: PreviewItem
  /** The photo's box, in the pane: the gestures read their edges from it. */
  frame: RefObject<HTMLDivElement | null>
  onBroken: () => void
}) {
  const { ready, onLoad, onError } = useImageReady(item.src ?? "")
  const [shape, setShape] = useState<{ width: number; height: number } | null>(
    item.width && item.height ? { width: item.width, height: item.height } : null,
  )
  const ratio = shape ? shape.width / shape.height : undefined
  const style = shape
    ? { aspectRatio: `${shape.width} / ${shape.height}`, width: `min(100cqw, 100cqh * ${ratio})` }
    : undefined
  return (
    <div
      ref={frame}
      className={cn("relative", !shape && "h-full w-full")}
      style={style}
      aria-busy={!ready || undefined}
    >
      {!ready && <Skeleton className="absolute inset-0 rounded-2xl" />}
      <img
        src={item.src}
        alt={item.name}
        onLoad={(event) => {
          onLoad()
          const img = event.currentTarget
          if (!shape && img.naturalWidth) {
            setShape({ width: img.naturalWidth, height: img.naturalHeight })
          }
        }}
        onError={() => {
          onError()
          onBroken()
        }}
        className={cn("h-full w-full rounded-2xl bg-muted object-contain", !ready && "invisible")}
        draggable={false}
      />
    </div>
  )
}

const TAP_SLOP_PX = 10
const DOUBLE_TAP_MS = 320
const DOUBLE_TAP_GAP_PX = 24

/** A finger on the photo, in the page's own px. */
interface Touch {
  x: number
  y: number
}

/** One touch on the photo, from the first finger landing to the last one lifting. */
interface Gesture {
  /** The fingers down, in the order they landed: a pinch is the first two of them. */
  fingers: Map<number, Touch>
  /** The view the touch began from, and where its first finger landed. */
  start: ZoomView
  downAt: Touch
  /** The pane's middle, in page px, measured when the touch landed. */
  centre: Touch
  /** The photo's own box and the pane it is drawn in, measured at the same moment. */
  frame: Frame
  /** The two fingers as they last were, which the next pinch move is measured against. */
  last: Pinch
  /** Whether this touch can still be a tap: false once it moves, or a second finger lands. */
  tappable: boolean
}

/**
 * A photo the reader can get closer to: a pinch about the point between the fingers, a double tap to
 * reading size and back again, and a drag while magnified. The page is held off this box by
 * `touch-none`, and every measurement a move needs is taken when the touch lands — a `pointermove`
 * that reads the layout forces a style recalculation on the gesture that has to hold frame rate.
 */
function Zoomed({ item, onRetry }: { item: PreviewItem; onRetry?: (item: PreviewItem) => void }) {
  const surface = useRef<HTMLDivElement | null>(null)
  const frame = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<ZoomView>(UNZOOMED)
  // What the transform on screen was drawn at, so two moves in one frame compose.
  const shown = useRef<ZoomView>(UNZOOMED)
  const [smooth, setSmooth] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  const [broken, setBroken] = useState(false)
  const [attempt, setAttempt] = useState(0)

  /** The next view, drawn when it differs from the one already on screen. */
  const apply = useCallback((next: ZoomView) => {
    shown.current = next
    setView((current) =>
      current.scale === next.scale && current.x === next.x && current.y === next.y ? current : next,
    )
  }, [])

  useEffect(() => {
    const photo = frame.current
    const pane = surface.current
    if (!photo || !pane) return
    const observer = new ResizeObserver(() =>
      apply(
        zoomSettled(shown.current, {
          photo: { width: photo.clientWidth, height: photo.clientHeight },
          pane: { width: pane.clientWidth, height: pane.clientHeight },
        }),
      ),
    )
    observer.observe(photo)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [apply, broken, attempt])

  const spread = (fingers: Touch[]) => {
    const [first, second] = fingers
    return second ? Math.hypot(second.x - first.x, second.y - first.y) : 0
  }
  const middle = (fingers: Touch[]): Touch => {
    const [first, second] = fingers
    return second ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } : first
  }
  /** A point of the page, in px from the middle of the pane: the space the rule anchors in. */
  const inPane = (point: Touch, pane: Touch): ZoomPoint => ({
    x: point.x - pane.x,
    y: point.y - pane.y,
  })

  const landed = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const held = gesture.current
    const fingers = new Map(held?.fingers ?? [])
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const down = [...fingers.values()]
    const rect = surface.current?.getBoundingClientRect()
    const photo = frame.current
    const centre = {
      x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
    }
    setSmooth(false)
    gesture.current = {
      fingers,
      start: shown.current,
      downAt: down.length > 1 ? middle(down) : down[0],
      centre,
      frame: {
        photo: { width: photo?.clientWidth ?? 0, height: photo?.clientHeight ?? 0 },
        pane: { width: rect?.width ?? 0, height: rect?.height ?? 0 },
      },
      last: { spread: down.length > 1 ? spread(down) : 0, middle: inPane(middle(down), centre) },
      tappable: down.length === 1,
    }
    if (down.length > 1) lastTap.current = null
  }

  const travelled = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = gesture.current
    if (!held?.fingers.has(event.pointerId)) return
    held.fingers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const down = [...held.fingers.values()]
    if (down.length > 1) {
      const now = { spread: spread(down), middle: inPane(middle(down), held.centre) }
      // Two fingers that landed on one px have nothing to scale by: the move that parts them starts
      // the pinch, and diving by a zero spread would jump to the ceiling.
      if (!held.last.spread) {
        if (now.spread) held.last = now
        return
      }
      apply(zoomPinched(shown.current, held.last, now, held.frame))
      held.last = now
      return
    }
    if (Math.hypot(event.clientX - held.downAt.x, event.clientY - held.downAt.y) > TAP_SLOP_PX)
      held.tappable = false
    if (held.start.scale === 1) return
    apply(
      zoomDragged(
        held.start,
        event.clientX - held.downAt.x,
        event.clientY - held.downAt.y,
        held.frame,
      ),
    )
  }

  /** Re-base the touch on the one finger still down: a drag from where it is, never a tap. */
  const rebase = (held: Gesture) => {
    if (held.fingers.size === 0) {
      gesture.current = null
      return
    }
    held.start = shown.current
    held.downAt = [...held.fingers.values()][0]
    held.tappable = false
  }

  const lifted = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = gesture.current
    if (!held) return
    const tapped = held.tappable && held.fingers.size === 1
    held.fingers.delete(event.pointerId)
    rebase(held)
    if (!tapped) return
    const point = { at: event.timeStamp, x: event.clientX, y: event.clientY }
    const before = lastTap.current
    lastTap.current = point
    if (!before || point.at - before.at > DOUBLE_TAP_MS) return
    if (Math.hypot(point.x - before.x, point.y - before.y) > DOUBLE_TAP_GAP_PX) return
    lastTap.current = null
    setSmooth(true)
    apply(zoomTapped(shown.current, inPane(point, held.centre), held.frame))
  }

  /** A touch the browser took away — a scroll, a system gesture — is never half of a double tap. */
  const dropped = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = gesture.current
    if (!held) return
    held.fingers.delete(event.pointerId)
    lastTap.current = null
    rebase(held)
  }

  if (broken)
    return (
      <Retry
        item={item}
        onRetry={() => {
          setBroken(false)
          setAttempt((count) => count + 1)
          onRetry?.(item)
        }}
      />
    )

  return (
    <div
      ref={surface}
      className="relative flex h-full w-full touch-none items-center justify-center overflow-hidden select-none"
      onPointerDown={landed}
      onPointerMove={travelled}
      onPointerUp={lifted}
      onPointerCancel={dropped}
    >
      <div
        data-slot="previewer-photo"
        className={cn(
          "flex h-full w-full items-center justify-center",
          view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-default",
          smooth && "transition-transform duration-200 ease-out motion-reduce:transition-none",
        )}
        style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
      >
        <Picture key={attempt} item={item} frame={frame} onBroken={() => setBroken(true)} />
      </div>
    </div>
  )
}

/** A file whose read failed: its place is kept, and this is the tap that asks the host again. */
function Retry({
  item,
  onRetry,
  onElsewhere,
}: {
  item: PreviewItem
  onRetry?: (item: PreviewItem) => void
  /** Hands the file to the platform, where the Previewer can't draw it. */
  onElsewhere?: () => void
}) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl bg-muted/50 px-4 py-10 text-center">
      <RotateCwIcon className="size-8 text-muted-foreground" />
      <span className="text-sm break-all text-muted-foreground">{item.name}</span>
      {item.note && <span className="text-sm text-balance">{item.note}</span>}
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="outline" className="min-h-11" onClick={() => onRetry?.(item)}>
          Try again
        </Button>
        {onElsewhere && (
          <Button variant="ghost" className="min-h-11" onClick={onElsewhere}>
            <ExternalLinkIcon data-icon="inline-start" />
            Open elsewhere
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * A page, drawn as the one rule for an untrusted document says (ADR 0114, 0134): its text is read,
 * the sandbox head is put first in it, and it runs in an opaque-origin frame — `allow-scripts`, never
 * `allow-same-origin` — so its own scripts work and reach nothing of the app's. No zoom or swipe
 * handlers sit over it, so the page keeps its own gestures; the stepping buttons are outside it.
 * The frame unmounts when the Previewer steps away or closes, which stops whatever the page runs.
 */
function Page({ item, onRetry }: { item: PreviewItem; onRetry?: (item: PreviewItem) => void }) {
  const src = item.src ?? ""
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ src: string; attempt: number; answer: PageRead } | null>(null)
  useEffect(() => {
    if (!src) return
    const stop = new AbortController()
    void readPage(src, { fetch: (url, init) => ask(url, init), signal: stop.signal }).then(
      (answer) => {
        if (!stop.signal.aborted) setRead({ src, attempt, answer })
      },
    )
    return () => stop.abort()
  }, [src, attempt])
  const answer = read && read.src === src && read.attempt === attempt ? read.answer : null
  const page = useMemo(
    () => (answer?.state === "ready" ? previewerPage(answer.html, item.folder) : null),
    [answer, item.folder],
  )
  if (!answer)
    return (
      <div data-slot="previewer-page" className="h-full w-full" aria-busy>
        <Skeleton className="h-full w-full rounded-2xl" />
      </div>
    )
  if (answer.state === "failed")
    return (
      <Retry
        item={{ ...item, note: answer.note }}
        onRetry={() => {
          setAttempt((count) => count + 1)
          // A signed URL may have run out: the caller asks the host again, and a new one lands here.
          onRetry?.(item)
        }}
        onElsewhere={() =>
          void openAttachment(null, { name: item.name, type: item.type, src: item.src })
        }
      />
    )
  return (
    <iframe
      data-slot="previewer-page"
      title={item.name}
      sandbox="allow-scripts"
      srcDoc={page ?? ""}
      referrerPolicy="no-referrer"
      className="h-full w-full rounded-2xl border-0 bg-white"
    />
  )
}

/** What the Previewer draws for one file: a photo at its shape, a clip or a recording on a player. */
function Shown({ item, onRetry }: { item: PreviewItem; onRetry?: (item: PreviewItem) => void }) {
  if (item.state === "failed" || (item.state === "ready" && !item.src))
    return <Retry item={item} onRetry={onRetry} />
  if (!item.src || item.state === "reading") return <Skeleton className="h-2/3 w-2/3 rounded-2xl" />
  if (item.kind === "page") return <Page key={item.key} item={item} onRetry={onRetry} />
  if (item.kind === "image") return <Zoomed key={item.key} item={item} onRetry={onRetry} />
  // A player the platform draws: it starts paused because nothing here asks it to play, and it
  // streams, seeks and buffers by its own rules rather than by anything this app holds.
  if (item.kind === "video")
    return (
      <video
        src={item.src}
        controls
        playsInline
        preload="metadata"
        aria-label={item.name}
        onError={() => onRetry?.(item)}
        className="h-full w-full rounded-2xl bg-muted object-contain"
      />
    )
  return (
    <audio
      src={item.src}
      controls
      preload="metadata"
      aria-label={item.name}
      onError={() => onRetry?.(item)}
      className="w-full max-w-md"
    />
  )
}

/**
 * One file at a time, in the app: the name, the size and where the reader is up top, the file in
 * the middle, and stepping and Remove below. Remove is drawn only where the caller passed one, so
 * a sent message has no way to be edited from here.
 */
export function Previewer({
  request,
  open,
  onIndex,
}: {
  request: PreviewRequest
  open: boolean
  onIndex: (index: number | null) => void
}) {
  const { items, index, onRemove, onRetry } = request
  const count = items.length
  const at = Math.min(Math.max(index, 0), count - 1)
  const item = items[at]
  const step = (by: number) => onIndex((at + by + count) % count)
  const close = () => onIndex(null)
  if (!item) return null
  const details = [
    item.size ? formatBytes(item.size) : undefined,
    count > 1 && `${at + 1} of ${count}`,
  ]

  return (
    <FullscreenPopup open={open} onOpenChange={(next) => !next && close()}>
      <div
        className="flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onKeyDown={(event) => {
          if (count < 2) return
          if (event.key === "ArrowLeft") step(-1)
          if (event.key === "ArrowRight") step(1)
        }}
      >
        <header className="flex items-center gap-2 px-2 py-2 sm:px-4">
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 shrink-0"
            aria-label="Close"
            onClick={close}
          >
            <XIcon />
          </Button>
          <div className="min-w-0 flex-1">
            <PopupTitle className="justify-start text-left">{item.name}</PopupTitle>
            <p className="text-sm text-muted-foreground tabular-nums">
              {details.filter(Boolean).join(" · ")}
            </p>
          </div>
        </header>
        <div className="[container-type:size] mx-4 flex min-h-0 flex-1 items-center justify-center sm:mx-6">
          <Shown item={item} onRetry={onRetry} />
        </div>
        {(count > 1 || onRemove) && (
          <div className="flex items-center gap-2 px-4 pt-3 sm:px-6">
            {count > 1 && (
              <>
                <Button
                  variant="outline"
                  size="icon-lg"
                  className="size-11 rounded-full"
                  aria-label="Previous"
                  onClick={() => step(-1)}
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  variant="outline"
                  size="icon-lg"
                  className="size-11 rounded-full"
                  aria-label="Next"
                  onClick={() => step(1)}
                >
                  <ChevronRightIcon />
                </Button>
              </>
            )}
            <span className="flex-1" />
            {onRemove && (
              <Button
                variant="ghost"
                className="min-h-11 text-destructive"
                onClick={() => {
                  onRemove(item)
                  if (count > 1) onIndex(Math.min(at, count - 2))
                  else close()
                }}
              >
                <Trash2Icon data-icon="inline-start" />
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
    </FullscreenPopup>
  )
}
