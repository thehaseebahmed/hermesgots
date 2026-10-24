import { useSyncExternalStore } from "react"

import {
  attachmentParts,
  attachmentsText,
  formatBytes,
  splitAttachments,
} from "@/lib/attachment-text"
import { db, type Attachment } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { getPluginMedia, type ContentPart } from "@/lib/hermes"
import { createSignal } from "@/lib/store"
import { randomId } from "@/lib/utils"

export { attachmentsText, formatBytes, splitAttachments }

/** Under the API server's 10 MB request cap, which the plugin's upload shares. */
export const MAX_FILE_BYTES = 9 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
/** Photos go inline as base64 (a third bigger), so together they must leave the request room. */
export const MAX_INLINE_BYTES = 6.5 * 1024 * 1024
/** Long edge models are given; bigger images are scaled down before they go, to keep the body small. */
const MAX_EDGE = 1600
const KEEP_AS_IS_BYTES = 1024 * 1024
// SVG isn't something providers take as an image, so it goes as a file.
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/

/** A photo on its way to storage: the file to keep, and its own size. */
type Photo = { blob: Blob; width: number; height: number }

async function scaled(file: File): Promise<Photo | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  try {
    const { width, height } = bitmap
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
    const sendable = /^image\/(jpeg|png|webp|gif)$/.test(file.type)
    if (scale === 1 && sendable && file.size <= KEEP_AS_IS_BYTES)
      return { blob: file, width, height }
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext("2d")
    if (!context) return null
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    )
    return blob && { blob, width: canvas.width, height: canvas.height }
  } finally {
    bitmap.close()
  }
}

function jpegName(name: string) {
  return /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^./]+$/, "") || "photo"}.jpg`
}

/**
 * Reads a picked file into an attachment. Images the browser can decode are scaled down, unless
 * the model can't take images (`inline: false`), when they go as files.
 */
export async function prepareAttachment(file: File, inline = true): Promise<Attachment> {
  const name = file.name || "file"
  if (inline && IMAGE_TYPES.test(file.type)) {
    const photo = await scaled(file)
    if (photo) {
      const { blob, width, height } = photo
      const reencoded = blob !== file
      return {
        id: randomId(),
        name: reencoded ? jpegName(name) : name,
        type: blob.type || file.type,
        size: blob.size,
        image: true,
        blob,
        width,
        height,
      }
    }
  }
  if (file.size > MAX_FILE_BYTES)
    throw new Error(`${name} is over the ${formatBytes(MAX_FILE_BYTES)} limit.`)
  return {
    id: randomId(),
    name,
    type: file.type || "application/octet-stream",
    size: file.size,
    image: false,
    blob: file,
  }
}

/** Whether there's anything on this device to show for it. */
export const openable = (attachment: Attachment) => Boolean(attachment.blob)

/** The bytes a message's photos add to its request. */
export const inlineBytes = (attachments: Attachment[]) =>
  attachments.reduce((sum, a) => sum + (a.image && a.blob ? a.blob.size : 0), 0)

/**
 * Saves a file this device doesn't hold — one another device sent, or one a restored message names
 * — under the file's own name. The bytes come from the bot's plugin media route, which a plain link
 * can't call without the key, so they are fetched and handed to the browser as a download.
 */
export async function downloadAttachment(conversationId: string, attachment: Attachment) {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  if (!profile || !attachment.path) throw new Error(`There is no copy of ${attachment.name}.`)
  const blob = await getPluginMedia(profile, attachment.path, AbortSignal.timeout(READ_TIMEOUT_MS))
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = attachment.name
  document.body.append(link)
  link.click()
  link.remove()
  // The browser reads the bytes after the click returns, so the URL outlives it.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Attachments being saved on the Hermes host right now, so their tiles can say so.
const uploading = new Set<string>()
const uploads = createSignal()

export function setUploading(id: string, busy: boolean) {
  if (busy === uploading.has(id)) return
  if (busy) uploading.add(id)
  else uploading.delete(id)
  uploads.notify()
}

export function useUploading(id: string) {
  return useSyncExternalStore(uploads.subscribe, () => uploading.has(id))
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."))
    reader.readAsDataURL(blob)
  })
}

/** The message's content for Hermes: the text with a marker per attachment, and each photo inline. */
export async function wireContent(
  text: string,
  attachments: Attachment[] = [],
): Promise<string | ContentPart[]> {
  if (!attachments.length) return text
  const parts = attachmentParts(text, attachments)
  for (const attachment of attachments)
    if (attachment.image && attachment.blob)
      parts.push({ type: "image_url", image_url: { url: await blobToDataUrl(attachment.blob) } })
  return parts
}
