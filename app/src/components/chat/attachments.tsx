import { useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { formatBytes, useUploading } from "@/lib/attachments"
import type { Attachment } from "@/lib/db"
import { isNative } from "@/lib/native"
import { cn } from "@/lib/utils"

// One URL per attachment for the page's life: live queries hand back a new Blob on every change.
const urls = new Map<string, string>()

function objectUrl(attachment: Attachment) {
  if (!attachment.blob) return undefined
  let url = urls.get(attachment.id)
  if (!url) {
    url = URL.createObjectURL(attachment.blob)
    urls.set(attachment.id, url)
  }
  return url
}

// Types a browser tab shows rather than downloads.
const VIEWABLE = /^(image\/|text\/|application\/(pdf|json)$)/

/**
 * A photo as a thumbnail, or a file (and a photo another device sent, which Hermes doesn't give
 * back) as its name. With `onRemove`, a button takes it off the message; with `onOpen`, tapping it
 * opens it. `preparing` is a photo still being scaled down.
 */
export function AttachmentTile({
  attachment,
  preparing,
  onOpen,
  onRemove,
  className,
}: {
  attachment: Attachment
  preparing?: boolean
  onOpen?: () => void
  onRemove?: () => void
  className?: string
}) {
  const uploading = useUploading(attachment.id)
  const url = attachment.image ? objectUrl(attachment) : undefined
  const Icon = attachment.image ? ImageIcon : FileIcon
  const busy = preparing || uploading
  const tile = url ? (
    <img
      src={url}
      alt={attachment.name}
      className={cn("size-16 rounded-xl border object-cover", busy && "opacity-50")}
      draggable={false}
    />
  ) : preparing ? (
    <div className="size-16 animate-pulse rounded-xl border bg-muted" />
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
      <span className="line-clamp-2 break-all">{attachment.name}</span>
    </div>
  )
  return (
    <div className={cn("relative shrink-0", className)} aria-busy={busy || undefined}>
      {onOpen && !preparing ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${attachment.name}`}
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

/** A photo at full size, holding its place while it decodes. Keyed by its url, so stepping to the
 * next one starts over. */
function LoadedImage({ url, name }: { url: string; name: string }) {
  const [ready, setReady] = useState(false)
  return (
    <div className="relative">
      {!ready && <Skeleton className="h-[55dvh] w-full rounded-2xl" />}
      <img
        src={url}
        alt={name}
        onLoad={() => setReady(true)}
        // A photo that won't decode must not leave the pulse running.
        onError={() => setReady(true)}
        className={cn(
          "max-h-[55dvh] w-full rounded-2xl bg-muted object-contain",
          !ready && "invisible absolute inset-x-0 top-0",
        )}
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

  const url = shown ? objectUrl(shown) : undefined
  const image = shown?.image && url
  const details = shown && [
    shown.size ? formatBytes(shown.size) : undefined,
    count > 1 && `${at + 1} of ${count}`,
  ]

  return (
    <Popup open={index !== null} onOpenChange={(open) => !open && onIndex(null)}>
      <PopupContent size="2xl">
        <PopupHeader>
          <PopupTitle className="truncate">{shown?.name}</PopupTitle>
          <p className="text-sm text-muted-foreground tabular-nums">
            {details?.filter(Boolean).join(" · ")}
          </p>
        </PopupHeader>
        <div
          className="flex flex-col gap-4 px-4 sm:px-6"
          onKeyDown={(event) => {
            if (count < 2) return
            if (event.key === "ArrowLeft") step(-1)
            if (event.key === "ArrowRight") step(1)
          }}
        >
          {image ? (
            <LoadedImage key={url} url={url} name={shown.name} />
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-2xl bg-muted/50 px-4 py-10 text-center">
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
          {(count > 1 || onRemove) && (
            <div className="flex items-center gap-2">
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
      </PopupContent>
    </Popup>
  )
}
