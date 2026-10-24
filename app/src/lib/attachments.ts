import { useSyncExternalStore } from "react"
import { toast } from "sonner"

import {
  fitsInline,
  inlineRefusal,
  intake,
  isPhoto,
  keptImage,
  MAX_FILE_BYTES,
  sizeRefusal,
  type Refusal,
} from "@/lib/attachment-caps"
import { attachmentParts } from "@/lib/attachment-text"
import type { Attachment } from "@/lib/db"
import type { ContentPart } from "@/lib/hermes"
import { loadMediaFile } from "@/lib/media-tags"
import { noteFailure } from "@/lib/report"
import { createSignal } from "@/lib/store"
import { randomId } from "@/lib/utils"

/** Long edge models are given; bigger images are scaled down before they go, to keep the body small. */
const MAX_EDGE = 1600
const KEEP_AS_IS_BYTES = 1024 * 1024

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
 * Reads a picked file into an attachment. An image the browser can decode is scaled down for the
 * model, while the copy kept — the bytes the host stores and this device caches — stays the file
 * the user chose, unless it is too big to send, when the scaled copy stands in for it. With
 * `inline: false` (a model that takes no images) every image goes as the file it is.
 */
export async function prepareAttachment(file: File, inline = true): Promise<Attachment> {
  const name = file.name || "file"
  if (inline && isPhoto(file.type)) {
    const photo = await scaled(file)
    if (photo) {
      const { kept, inline: part } = keptImage<Blob>(file, photo.blob)
      return {
        id: randomId(),
        name: kept === file ? name : jpegName(name),
        type: kept.type || file.type,
        size: kept.size,
        image: true,
        blob: kept,
        ...(part ? { inline: part } : {}),
        width: photo.width,
        height: photo.height,
      }
    }
  }
  if (file.size > MAX_FILE_BYTES) throw new Error(sizeRefusal(name).message)
  return {
    id: randomId(),
    name,
    type: file.type || "application/octet-stream",
    size: file.size,
    image: false,
    blob: file,
  }
}

/** What an attachment adds to a request inline: an image's scaled part, and nothing else. */
export const inlineSize = (attachment: Attachment) =>
  attachment.image ? ((attachment.inline ?? attachment.blob)?.size ?? 0) : 0

/** The bytes a message's photos add to its request. */
export const inlineBytes = (attachments: Attachment[]) =>
  attachments.reduce((sum, attachment) => sum + inlineSize(attachment), 0)

/** What a set of files became on a message: the attachments it took, and why it took no others. */
export interface PreparedIntake {
  attachments: Attachment[]
  refusals: Refusal[]
}

/**
 * What `files` becomes on a message already holding `held` attachments — the one intake a pick, a
 * paste, a drop and a share land through. `onTake` is how a surface holds the place of the files it
 * is now reading.
 */
export async function prepareIntake(
  files: File[],
  {
    held = [],
    reserved = 0,
    inline = true,
    onTake,
  }: {
    /** The attachments the message already carries, whose count and inline room these share. */
    held?: Attachment[]
    /** Files already being read for this message, which hold a place in the count. */
    reserved?: number
    /** Whether the model takes images; with none, an image goes as the file it is. */
    inline?: boolean
    /** Called with the files that passed the caps, before any of them is read. */
    onTake?: (take: File[]) => void
  } = {},
): Promise<PreparedIntake> {
  const { take, refusals } = intake(files, held.length + reserved, { inline })
  onTake?.(take)
  const answers = await Promise.all(
    take.map(async (file): Promise<{ attachment?: Attachment; error?: Error }> => {
      try {
        return { attachment: await prepareAttachment(file, inline) }
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(`Couldn't attach ${file.name}.`),
        }
      }
    }),
  )
  let used = inlineBytes(held)
  const attachments: Attachment[] = []
  for (const [index, answer] of answers.entries()) {
    if (!answer.attachment) {
      refusals.push({
        limit: "read",
        message: answer.error?.message ?? `Couldn't attach ${take[index].name}.`,
      })
      continue
    }
    const size = inlineSize(answer.attachment)
    if (!fitsInline(size, used)) {
      refusals.push(inlineRefusal(answer.attachment.name))
      continue
    }
    used += size
    attachments.push(answer.attachment)
  }
  return { attachments, refusals }
}

/**
 * Saves an attachment under the file's own name: the bytes this device holds, else the host's copy,
 * read the way the thread reads it (`loadMediaFile`), so a file on screen is never fetched twice.
 * A failed save is said to the user here, so a caller only says which file to save.
 */
export async function downloadAttachment(conversationId: string, attachment: Attachment) {
  try {
    const blob = attachment.blob ?? (await hostCopy(conversationId, attachment))
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = attachment.name
    document.body.append(link)
    link.click()
    link.remove()
    // The browser reads the bytes after the click returns, so the URL outlives it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) {
    noteFailure(`saving ${attachment.name}`, error)
    toast.error(error instanceof Error ? error.message : `Couldn't download ${attachment.name}.`)
  }
}

/** The host's copy of a file this device doesn't hold, through the media route's own read. */
async function hostCopy(conversationId: string, attachment: Attachment) {
  const file = attachment.path ? await loadMediaFile(conversationId, attachment.path) : null
  if (!file) throw new Error(`There is no copy of ${attachment.name}.`)
  return file.blob
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
  // The model reads the scaled copy, never a file too big for the request to carry.
  for (const attachment of attachments) {
    const part = attachment.inline ?? attachment.blob
    if (attachment.image && part)
      parts.push({ type: "image_url", image_url: { url: await blobToDataUrl(part) } })
  }
  return parts
}
