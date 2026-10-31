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
import { loadMediaUrl } from "@/lib/media-url"
import { isNative, openMediaViewer } from "@/lib/native"
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

/** A file a thread hands over: what it is called, what it is, and wherever its bytes are reachable. */
export type Handover = Pick<Attachment, "name" | "type" | "path" | "blob"> & {
  /** The URL the thread already holds for it, so a tap opens at once. */
  src?: string
}

/**
 * Hands a file to the platform, by one rule: the bytes this device holds, the URL the host signed
 * for it, or — before that URL is in — one asked for here. On the web that is a new tab, where a PDF
 * or a note is shown and anything else is saved under its own name; under Android the phone's own
 * app, through the VIEW intent this app already uses for media. No second download affordance is
 * drawn: the destination decides. A failed hand-over is said to the user here, so a caller only
 * says which file to hand over.
 *
 * `conversationId` is null for a file this device picked and the host was never given: its own
 * bytes are all there is, and nothing is asked of a host.
 */
export async function openAttachment(conversationId: string | null, file: Handover) {
  try {
    // The URL first, where the thread holds one: the host names the file in how it serves it, which
    // this device's own blob can't. A staged file has no URL, so its bytes are all there is.
    if (!file.src && !file.path && file.blob) {
      const url = URL.createObjectURL(file.blob)
      try {
        // A staged file's bytes have no name of their own in a URL: the browser saves them under
        // the blob's, and the platform's app is handed the name with the bytes.
        if (!isNative) window.open(url, "_blank", "noopener")
        else await openMediaViewer(url, { type: file.type, name: file.name })
      } finally {
        // The browser reads the bytes after the click returns, so the URL outlives it.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      return
    }
    const read =
      file.src ??
      (conversationId && file.path
        ? (await loadMediaUrl(conversationId, file.path))?.url
        : undefined)
    if (!read) throw new Error(`There is no copy of ${file.name}.`)
    await openMediaViewer(read, { type: file.type, name: file.name })
  } catch (error) {
    noteFailure(`opening ${file.name}`, error)
    toast.error(error instanceof Error ? error.message : `Couldn't open ${file.name}.`)
  }
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
