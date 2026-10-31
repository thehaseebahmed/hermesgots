import { DownloadIcon, FileIcon, ImageIcon, XIcon } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { attachmentUrl } from "@/lib/attachment-url"
import { formatBytes } from "@/lib/attachment-caps"
import { useUploading } from "@/lib/attachments"
import type { Attachment } from "@/lib/db"
import { cn } from "@/lib/utils"

/** A file's name over its size: a staged tile, a thread's row that saves it, and a recording's row. */
export function MediaName({ name, size }: { name: string; size?: number }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="line-clamp-1 break-all">{name}</span>
      {size ? (
        <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(size)}</span>
      ) : null}
    </span>
  )
}

/**
 * A file that isn't a photo, as its row: what it's called, what it weighs, and a tap that hands it
 * to the platform, which shows or saves it. The thread draws a reply's files through this, where
 * there is no attachment of the message's own to draw.
 */
export function FileRow({
  name,
  size,
  onSave,
  className,
}: {
  name: string
  /** What the host said it weighs, where it said. */
  size?: number
  onSave?: () => void
  className?: string
}) {
  return (
    <div className={cn("relative shrink-0", className)}>
      <button
        type="button"
        onClick={onSave}
        aria-label={`Download ${name}`}
        className="flex h-16 max-w-48 min-w-28 items-center gap-2 rounded-xl border bg-muted/50 px-3 text-left text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <DownloadIcon className="size-5 shrink-0 text-muted-foreground" />
        <MediaName name={name} size={size} />
      </button>
    </div>
  )
}

/**
 * A photo as a thumbnail, or a file as its name and size. With `onRemove`, a button takes it off the
 * message; with `onOpen`, a tap opens it, or saves it where `action` says a tap saves.
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
      <MediaName name={attachment.name} size={attachment.size} />
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
