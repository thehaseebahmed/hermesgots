import type { Attachment } from "@/lib/db"
import type { ContentPart } from "@/lib/hermes"
import { randomId } from "@/lib/utils"

/** Under the API server's 10 MB request cap, which the plugin's upload shares. */
export const MAX_FILE_BYTES = 9 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
/** Long edge models are given; bigger images are scaled down before they go, to keep the body small. */
const MAX_EDGE = 1600
const KEEP_AS_IS_BYTES = 1024 * 1024
// SVG isn't something providers take as an image, so it goes as a file.
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/

async function scaled(file: File): Promise<Blob | null> {
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
    if (scale === 1 && sendable && file.size <= KEEP_AS_IS_BYTES) return file
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext("2d")
    if (!context) return null
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85))
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
    const blob = await scaled(file)
    if (blob) {
      const reencoded = blob !== file
      return {
        id: randomId(),
        name: reencoded ? jpegName(name) : name,
        type: blob.type || file.type,
        size: blob.size,
        image: true,
        blob,
      }
    }
  }
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is too large to attach.`)
  return {
    id: randomId(),
    name,
    type: file.type || "application/octet-stream",
    size: file.size,
    image: false,
    blob: file,
  }
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."))
    reader.readAsDataURL(blob)
  })
}

const escapeAttr = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

const unescapeAttr = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** The line that tells the model about an attachment, and where the plugin saved it. */
function marker(attachment: Attachment) {
  const attrs: [string, string][] = [
    ["name", attachment.name],
    ["type", attachment.type],
    ...(attachment.path ? ([["path", attachment.path]] as [string, string][]) : []),
  ]
  return `<attachment ${attrs.map(([key, value]) => `${key}="${escapeAttr(value)}"`).join(" ")} />`
}

const MARKER = /^<attachment((?:\s+[a-z]+="[^"]*")*)\s*\/>$/
// What Hermes keeps of an inline image in its transcript.
const IMAGE_PLACEHOLDER = "[screenshot]"

/** The message as Hermes's transcript keeps it: the text, then a line per attachment. */
export function attachmentsText(text: string, attachments: Attachment[] = []) {
  return [
    text,
    ...attachments.map((a) => (a.image ? `${marker(a)}\n${IMAGE_PLACEHOLDER}` : marker(a))),
  ]
    .filter(Boolean)
    .join("\n")
}

/** The message's content for Hermes: parts with each image inline when it has attachments. */
export async function wireContent(
  text: string,
  attachments: Attachment[] = [],
): Promise<string | ContentPart[]> {
  if (!attachments.length) return text
  const parts: ContentPart[] = text ? [{ type: "text", text }] : []
  for (const attachment of attachments) {
    parts.push({ type: "text", text: marker(attachment) })
    if (attachment.image && attachment.blob)
      parts.push({ type: "image_url", image_url: { url: await blobToDataUrl(attachment.blob) } })
  }
  return parts
}

/** Splits a transcript row's text back into what the user typed and what they attached. */
export function splitAttachments(content: string): { text: string; attachments: Attachment[] } {
  const lines = content.split("\n")
  const attachments: Attachment[] = []
  let end = lines.length
  let image = false
  while (end > 0) {
    const line = lines[end - 1].trim()
    if (line === IMAGE_PLACEHOLDER && !image) {
      image = true
      end--
      continue
    }
    const match = MARKER.exec(line)
    if (!match) break
    const attrs = Object.fromEntries(
      [...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [
        key,
        unescapeAttr(value),
      ]),
    )
    attachments.unshift({
      id: `${end}`,
      name: attrs.name || "file",
      type: attrs.type || "application/octet-stream",
      size: 0,
      image,
      path: attrs.path || undefined,
    })
    image = false
    end--
  }
  // A placeholder with no attachment line before it is the user's own text.
  if (image) end++
  return attachments.length
    ? { text: lines.slice(0, end).join("\n"), attachments }
    : { text: content, attachments }
}
