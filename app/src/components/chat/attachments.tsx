import { useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { FullscreenPopup, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { attachmentUrl } from "@/lib/attachment-url"
import { formatBytes, useUploading } from "@/lib/attachments"
import type { Attachment } from "@/lib/db"
import { useImageReady } from "@/lib/image"
import { isNative } from "@/lib/native"
import { cn } from "@/lib/utils"

// Types a browser tab shows rather than downloads.
const VIEWABLE = /^(image\/|text\/|application\/(pdf|json)$)/

/**
 * A photo as a thumbnail, or a file (and a photo another device sent, which Hermes doesn't give
 * back) as its name and size. With `onRemove`, a button takes it off the message; with `onOpen`,
 * tapping it opens it — or, for a file this device doesn't hold, downloads it. `preparing` is a
 * photo still being scaled down.
 */
export function AttachmentTile({
  attachment,
  preparing,
  action = "open",
  onOpen,
  onRemove,
  className,
}: {
  attachment: Attachment
  preparing?: boolean
  /** What a tap does: open it here, or save it from the host. */
  action?: "open" | "download"
  onOpen?: () => void
  onRemove?: () => void
  className?: string
}) {
  const uploading = useUploading(attachment.id)
  const url = attachment.image ? attachmentUrl(attachment) : undefined
  const Icon = attachment.image ? ImageIcon : action === "download" ? DownloadIcon : FileIcon
  const busy = preparing || uploading
  const tile = url ? (
    <img
      src={url}
      alt={attachment.name}
      className={cn("size-16 rounded-xl border object-cover", busy && "opacity-50")}
      draggable={false}
    />
  ) : preparing ? (
    <Skeleton className="size-16 border" />
  ) : (
    <div
      className={cn(
        "flex h-16 max-w-48 min-w-28 items-center gap-2 rounded-xl border bg-muted/50 px-3 text-left text-sm text-foreground",
        busy && "text-muted-foreground",
      )}
      title={attachment.name}
    >
      {busy ? (
        <Spinner className="size-5 shrink-0 text-muted-foreground" />
      ) : (
        <Icon className="size-5 shrink-0 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="line-clamp-1 break-all">{attachment.name}</span>
        {/* A restored message keeps its size, so its row reads as the one that sent it did. */}
        {attachment.size ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(attachment.size)}
          </span>
        ) : null}
      </span>
    </div>
  )
  return (
    <div className={cn("relative shrink-0", className)} aria-busy={busy || undefined}>
      {onOpen && !preparing ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${action === "download" ? "Download" : "Open"} ${attachment.name}`}
          className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {tile}
        </button>
      ) : (
        tile
      )}
      {busy && (url || preparing) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-5 text-foreground" />
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          // A 44px target around a small visible dot.
          className="absolute -top-3.5 -right-3.5 flex size-11 items-center justify-center"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow">
            <XIcon className="size-3" />
          </span>
        </button>
      )}
    </div>
  )
}

/** A photo at full size, holding the box it lands in while it's read. */
function LoadedImage({
  url,
  name,
  width,
  height,
}: {
  url: string
  name: string
  width?: number
  height?: number
}) {
  const { ready, onLoad, onError } = useImageReady(url)
  // The photo's own shape, kept on the record, so its box is right from the first frame and the
  // viewer doesn't jump when the photo paints. A photo with no size on it (one the host sent back,
  // which this device never read) fills the viewer.
  const ratio = width && height ? width / height : undefined
  return (
    <div
      className={cn("relative", !ratio && "h-full w-full")}
      // As large as the viewer's room allows at the photo's own shape.
      style={
        ratio
          ? { aspectRatio: `${width} / ${height}`, width: `min(100cqw, 100cqh * ${ratio})` }
          : undefined
      }
      aria-busy={!ready || undefined}
    >
      {!ready && <Skeleton className="absolute inset-0 rounded-2xl" />}
      <img
        src={url}
        alt={name}
        onLoad={onLoad}
        onError={onError}
        className={cn("h-full w-full rounded-2xl bg-muted object-contain", !ready && "invisible")}
        draggable={false}
      />
    </div>
  )
}

/** A message's attachments, one at a time: a photo full size, a file with a way to open it. */
export function AttachmentViewer({
  attachments,
  index,
  onIndex,
  onRemove,
}: {
  attachments: Attachment[]
  /** The one on screen, or null when closed. */
  index: number | null
  onIndex: (index: number | null) => void
  onRemove?: (attachment: Attachment) => void
}) {
  // Kept while the pop-up animates out, so it doesn't empty first.
  const [last, setLast] = useState<Attachment | undefined>()
  const current = index === null ? undefined : attachments[Math.min(index, attachments.length - 1)]
  if (current && current !== last) setLast(current)
  const shown = current ?? last
  const at = shown ? attachments.findIndex((a) => a.id === shown.id) : -1
  const count = attachments.length
  const step = (by: number) => onIndex((at + by + count) % count)

  const url = shown ? attachmentUrl(shown) : undefined
  const image = shown?.image && url
  const details = shown && [
    shown.size ? formatBytes(shown.size) : undefined,
    count > 1 && `${at + 1} of ${count}`,
  ]

  const close = () => onIndex(null)

  // An image wants the whole screen, so the viewer takes it on every size, with the name and the
  // way out on top and stepping and Remove below.
  return (
    <FullscreenPopup open={index !== null} onOpenChange={(open) => !open && close()}>
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
            <PopupTitle className="justify-start text-left">{shown?.name}</PopupTitle>
            <p className="text-sm text-muted-foreground tabular-nums">
              {details?.filter(Boolean).join(" · ")}
            </p>
          </div>
        </header>
        <div className="[container-type:size] mx-4 flex min-h-0 flex-1 items-center justify-center sm:mx-6">
          {image ? (
            <LoadedImage url={url} name={shown.name} width={shown.width} height={shown.height} />
          ) : (
            <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl bg-muted/50 px-4 py-10 text-center">
              <FileIcon className="size-10 text-muted-foreground" />
              <span className="text-sm break-all text-muted-foreground">{shown?.type}</span>
              {url && !isNative && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  render={
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener"
                      download={VIEWABLE.test(shown!.type) ? undefined : shown!.name}
                    />
                  }
                >
                  <ExternalLinkIcon data-icon="inline-start" />
                  Open
                </Button>
              )}
            </div>
          )}
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
            {onRemove && shown && (
              <Button
                variant="ghost"
                className="min-h-11 text-destructive"
                onClick={() => {
                  onRemove(shown)
                  onIndex(count > 1 ? Math.min(at, count - 2) : null)
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
