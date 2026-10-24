import type { Attachment } from "@/lib/db"
import { boundedStore } from "@/lib/bounded-cache"
import { renderableImage } from "@/lib/media-kind"

// One URL per attachment, so a live query handing back a fresh Blob on every change doesn't make
// every image on screen flash. Bounded, because each URL holds its whole file open: a thread read
// through for a while would otherwise keep every one of them.
const urls = boundedStore<string>({
  limit: 128,
  dispose: (url) => URL.revokeObjectURL(url),
})

/**
 * What this device draws for an attachment: the file the user chose — a clip, an animation, a
 * transparent PNG — or, for a photo a browser can't render (a HEIC), the scaled copy the model was
 * given, which is the only form of it a browser draws.
 */
export function drawingBlob(attachment: Attachment) {
  if (attachment.image && attachment.inline && !renderableImage(attachment.type))
    return attachment.inline
  return attachment.blob
}

/** This device's own bytes behind an attachment, as an object URL, or nothing where it holds none. */
export function attachmentUrl(attachment: Attachment) {
  const blob = drawingBlob(attachment)
  if (!blob) return undefined
  let url = urls.get(attachment.id)
  if (!url) {
    url = URL.createObjectURL(blob)
    urls.set(attachment.id, url)
  }
  return url
}
