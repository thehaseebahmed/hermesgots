import { FileIcon, ImageIcon, XIcon } from "lucide-react"

import type { Attachment } from "@/lib/db"
import { cn } from "@/lib/utils"

// One URL per photo for the page's life: live queries hand back a new Blob on every change.
const urls = new Map<string, string>()

function objectUrl(attachment: Attachment) {
  if (!attachment.image || !attachment.blob) return undefined
  let url = urls.get(attachment.id)
  if (!url) {
    url = URL.createObjectURL(attachment.blob)
    urls.set(attachment.id, url)
  }
  return url
}

/**
 * A photo as a thumbnail, or a file (and a photo another device sent, which Hermes doesn't give
 * back) as its name. With `onRemove`, a button takes it off the message.
 */
export function AttachmentTile({
  attachment,
  onRemove,
  className,
}: {
  attachment: Attachment
  onRemove?: () => void
  className?: string
}) {
  const url = objectUrl(attachment)
  const Icon = attachment.image ? ImageIcon : FileIcon
  return (
    <div className={cn("relative shrink-0", className)}>
      {url ? (
        <img
          src={url}
          alt={attachment.name}
          className="size-16 rounded-xl border object-cover"
          draggable={false}
        />
      ) : (
        <div
          className="flex h-16 max-w-48 min-w-28 items-center gap-2 rounded-xl border bg-muted/50 px-3 text-sm text-foreground"
          title={attachment.name}
        >
          <Icon className="size-5 shrink-0 text-muted-foreground" />
          <span className="line-clamp-2 break-all">{attachment.name}</span>
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
