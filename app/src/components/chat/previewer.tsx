import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { ChevronLeftIcon, ChevronRightIcon, RotateCwIcon, Trash2Icon, XIcon } from "lucide-react"

import { FullscreenPopup, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes } from "@/lib/attachment-caps"
import { useImageReady } from "@/lib/image"
import type { MediaKind } from "@/lib/media-kind"
import type { MediaStage } from "@/lib/media-stage"
import { cn } from "@/lib/utils"

/** One piece of media the Previewer can draw: a photo, a clip or a recording. */
export interface PreviewItem {
  /** Stable within the message: an attachment's id, or the place a tag was written at. */
  key: string
  name: string
  /** The file's own type, which is what the player is told it is. */
  type: string
  size?: number
  kind: Extract<MediaKind, "image" | "video" | "audio">
  /** Where it is read from, once the host has answered; a staged file's own bytes before that. */
  src?: string
  state: MediaStage
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
    <PreviewerContext.Provider value={face}>
      {children}
      {current && <Previewer request={current} open={shown !== null} onIndex={onIndex} />}
    </PreviewerContext.Provider>
  )
}

/** The face a part with no screen around it gets: a tap on media is inert, and nothing re-renders. */
const INERT: PreviewerFace = { open: () => {}, update: () => {} }

/** The screen's Previewer. */
export function usePreviewer(): PreviewerFace {
  return useContext(PreviewerContext) ?? INERT
}

/** A photo at its own shape, holding the box it lands in while its URL arrives. */
function Picture({ item, onRetry }: { item: PreviewItem; onRetry?: (item: PreviewItem) => void }) {
  const { ready, onLoad, onError } = useImageReady(item.src ?? "")
  // A photo the browser couldn't decode keeps its place and says so: one retry, not a loop.
  const [broken, setBroken] = useState(false)
  if (broken) return <Retry item={item} onRetry={onRetry} />
  // As large as the viewer's room allows at the photo's own shape.
  const ratio = item.width && item.height ? item.width / item.height : undefined
  const style = ratio
    ? { aspectRatio: `${item.width} / ${item.height}`, width: `min(100cqw, 100cqh * ${ratio})` }
    : undefined
  return (
    <div
      className={cn("relative", !ratio && "h-full w-full")}
      style={style}
      aria-busy={!ready || undefined}
    >
      {!ready && <Skeleton className="absolute inset-0 rounded-2xl" />}
      <img
        src={item.src}
        alt={item.name}
        onLoad={onLoad}
        onError={() => {
          onError()
          setBroken(true)
        }}
        className={cn("h-full w-full rounded-2xl bg-muted object-contain", !ready && "invisible")}
        draggable={false}
      />
    </div>
  )
}

/** A file whose read failed: its place is kept, and this is the tap that asks the host again. */
function Retry({ item, onRetry }: { item: PreviewItem; onRetry?: (item: PreviewItem) => void }) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl bg-muted/50 px-4 py-10 text-center">
      <RotateCwIcon className="size-8 text-muted-foreground" />
      <span className="text-sm break-all text-muted-foreground">{item.name}</span>
      <Button variant="outline" className="min-h-11" onClick={() => onRetry?.(item)}>
        Try again
      </Button>
    </div>
  )
}

/** What the Previewer draws for one file: a photo at its shape, a clip or a recording on a player. */
function Shown({ item, onRetry }: { item: PreviewItem; onRetry?: (item: PreviewItem) => void }) {
  if (item.state === "failed" || (item.state === "ready" && !item.src))
    return <Retry item={item} onRetry={onRetry} />
  if (!item.src || item.state === "reading") return <Skeleton className="h-2/3 w-2/3 rounded-2xl" />
  if (item.kind === "image") return <Picture item={item} onRetry={onRetry} />
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
