import { useSyncExternalStore } from "react"
import { toast } from "sonner"

import {
  carriesPart,
  fitsInline,
  inlineRefusal,
  intake,
  isPhoto,
  keptImage,
  MAX_FILE_BYTES,
  pickRoad,
  ridesInline,
  sizeRefusal,
  type Refusal,
  type RoadFacts,
  type RouteAnswer,
} from "@/lib/attachment-caps"
import { attachmentParts } from "@/lib/attachment-text"
import type { Attachment } from "@/lib/db"
import type { ContentPart } from "@/lib/hermes"
import { askNote, askThreadMediaUrl } from "@/lib/media-url"
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
 * One attachment, from what a read decided: the bytes kept, whether the file is a picture, and the
 * part the model is sent where one rides. The type and size are the kept bytes' own, so a scaled
 * copy can never be described as the photo it stands in for.
 */
function attachmentOf({
  name,
  blob,
  picture,
  part,
  width,
  height,
}: {
  name: string
  blob: Blob
  picture: boolean
  part?: Blob
  width?: number
  height?: number
}): Attachment {
  return {
    id: randomId(),
    name,
    type: blob.type || "application/octet-stream",
    size: blob.size,
    image: picture,
    blob,
    ...(part ? { inline: part } : {}),
    ...(width === undefined ? {} : { width, height }),
  }
}

export async function prepareAttachment(file: File, inline: boolean): Promise<Attachment> {
  const name = file.name || "file"
  if (!isPhoto(file.type)) {
    if (file.size > MAX_FILE_BYTES) throw new Error(sizeRefusal(name).message)
    return attachmentOf({ name, blob: file, picture: false })
  }
  const photo = inline || file.size > MAX_FILE_BYTES ? await scaled(file) : null
  if (!photo && file.size > MAX_FILE_BYTES) throw new Error(sizeRefusal(name).message)
  const { kept, inline: part } = keptImage<Blob>(file, photo?.blob ?? null)
  return attachmentOf({
    name: kept === file ? name : jpegName(name),
    blob: kept,
    picture: true,
    part: inline && photo ? part : undefined,
    width: photo?.width,
    height: photo?.height,
  })
}

/** What an attachment adds to a request inline: the bytes it carries for the model, and nothing else. */
export const inlineSize = (attachment: Attachment) =>
  carriesPart(attachment) ? attachment.inline.size : 0

/** The bytes a message's inline parts add to its request. */
export const inlineBytes = (attachments: Attachment[]) =>
  attachments.reduce((sum, attachment) => sum + inlineSize(attachment), 0)

/** What a set of files became on a message: the attachments it took, and why it took no others. */
export interface PreparedIntake {
  attachments: Attachment[]
  refusals: Refusal[]
}

export async function prepareIntake(
  files: File[],
  {
    held = [],
    reserved = 0,
    readsImages,
    route,
    maxAttachments,
    onTake,
  }: {
    /** The attachments the message already carries, whose count and inline room these share. */
    held?: Attachment[]
    /** Files already being read for this message, which hold a place in the count. */
    reserved?: number
    /** Whether the chosen model takes image input: `pickRoad`'s first fact. */
    readsImages: boolean
    /** What the host answered about the plugin's upload route: `pickRoad`'s second fact. */
    route: RouteAnswer
    /**
     * The most this surface takes, where it isn't a chat's ten: a room's Host caps a message lower,
     * and a file it would refuse is refused here rather than after it has gone up.
     */
    maxAttachments?: number
    /** Called with the files that passed the caps, before any of them is read. */
    onTake?: (take: File[]) => void
  },
): Promise<PreparedIntake> {
  const facts: RoadFacts = { readsImages, route }
  let because: string | null = null
  const onRoad = files.filter((file) => {
    const road = pickRoad({ ...facts, picture: isPhoto(file.type) })
    if (road.road === "none") because ??= road.message
    return road.road !== "none"
  })
  const { take, refusals: capped } = intake(onRoad, held.length + reserved, maxAttachments)
  const refusals: Refusal[] = because ? [{ limit: "route", message: because }, ...capped] : capped
  onTake?.(take)
  const answers = await Promise.all(
    take.map(async (file): Promise<{ attachment?: Attachment; error?: Error }> => {
      try {
        return { attachment: await prepareAttachment(file, ridesInline(file, facts)) }
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
 * `conversationId` is the thread whose bot mints a fresh URL for a file the host holds, and null is
 * a caller that has none to ask — a staged file's own bytes, or a host file with its URL already in
 * `src`. Nothing else about the hand-over changes between the two.
 */
export async function openAttachment(conversationId: string | null, file: Handover) {
  try {
    // A staged file has no path on the host: its own bytes are all there is, and they have no name
    // of their own in a URL, so the platform's own app is handed the name with them.
    if (!file.src && !file.path && file.blob) {
      const url = URL.createObjectURL(file.blob)
      try {
        if (!isNative) window.open(url, "_blank", "noopener")
        else await openMediaViewer(url, { type: file.type, name: file.name })
      } finally {
        // The browser reads the bytes after the click returns, so the URL outlives it.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      return
    }
    // A file the host holds is asked for a URL here, whatever one the thread was drawing from: the
    // host names the file in how it serves it, which a copy this device kept cannot, and what it
    // answers is fresh.
    const answer =
      conversationId && file.path ? await askThreadMediaUrl(conversationId, file.path) : null
    // The host's own sentence where it gave one — a cap it refused the file over is the one the
    // reader can act on, and saying "no copy" of a file it holds is a lie.
    if (answer && answer.state !== "ready") throw new Error(askNote(answer, file.name))
    const read = (answer?.state === "ready" ? answer.read.url : undefined) ?? file.src
    if (!read) throw new Error(`There is no copy of ${file.name}.`)
    await openMediaViewer(read, { type: file.type, name: file.name })
  } catch (error) {
    openFailed(file.name, error)
  }
}

/**
 * Says a file couldn't be opened, in the app's one voice — the platform's own sentence where it has
 * one, this app's otherwise — and records why. Every tap that hands a file over ends here, whether
 * the thread's row or a screen's own, so the two can't drift into saying different things.
 */
export function openFailed(name: string, error: unknown) {
  noteFailure(`opening ${name}`, error)
  toast.error(error instanceof Error ? error.message : `Couldn't open ${name}.`)
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

export async function wireContent(
  text: string,
  attachments: Attachment[] = [],
): Promise<string | ContentPart[]> {
  if (!attachments.length) return text
  const parts = attachmentParts(text, attachments)
  const carried = attachments.filter(carriesPart)
  const urls = await Promise.all(carried.map((attachment) => blobToDataUrl(attachment.inline)))
  for (const url of urls) parts.push({ type: "image_url", image_url: { url } })
  return parts
}
