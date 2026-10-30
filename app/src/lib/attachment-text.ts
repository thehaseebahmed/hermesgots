/**
 * What a message tells the model about the files it carries, and how the thread reads them back:
 * one `<attachment>` marker line per file — its name, its type, its size and where the plugin saved
 * it — then, once, the sentence that the content itself is not included. Import-free but for types,
 * `media-kind.ts` and `steer.ts` (both pure), so `scripts/test-attachments.mjs` runs it as a rule.
 */
import type { Attachment } from "@/lib/db"
import type { ContentPart } from "@/lib/hermes"
import { fileNameOf } from "./media-kind.ts"
import { steerText } from "./steer.ts"

/**
 * Told once per message, after the last marker: the bytes stay on the host, and the agent's own
 * file tools are what turn a path into content.
 */
export const NOT_INLINED =
  "The content of each file is not included in this message: open it on the host and extract the text yourself."

// What Hermes keeps of an inline image in its transcript, and the details a caller may ride on it
// (`session_persistence._image_marker`). Both are held to the host's spelling by
// `.github/scripts/check-hermes-internals.py`.
export const IMAGE_PLACEHOLDER = "[screenshot]"
export const SCREENSHOT_DETAILS = ["low", "high", "auto"]

const UNNAMED_TYPE = "application/octet-stream"

/**
 * The line Hermes adds to a message's text for an inline photo it committed to the profile's cache,
 * naming the copy — a handle for the tools that take an image's path, never words for the reader
 * (`restore_api_images` in `gateway/session_api_media.py`).
 */
export const IMAGE_ATTACHED_AT = "[Image attached at: "
/** The same, for a photo the message named by address rather than sent. */
export const IMAGE_ATTACHED = "[Image attached: "

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
export function marker(attachment: Attachment) {
  const attrs: [string, string][] = [
    ["name", attachment.name],
    ["type", attachment.type],
    ["size", String(attachment.size ?? 0)],
    ...(attachment.path ? ([["path", attachment.path]] as [string, string][]) : []),
  ]
  return `<attachment ${attrs.map(([key, value]) => `${key}="${escapeAttr(value)}"`).join(" ")} />`
}

/**
 * Whether the message has to say its files aren't inlined: a photo rides along as an image part,
 * so only a message carrying a file needs telling.
 */
const needsInstruction = (attachments: Attachment[]) => attachments.some((a) => !a.image)

/** The message as Hermes's transcript keeps it: the text, then a line per attachment. */
export function attachmentsText(text: string, attachments: Attachment[] = []) {
  const sent = attachments.filter((attachment) => !attachment.host)
  return [
    text,
    ...sent.map((a) => (a.image ? `${marker(a)}\n${IMAGE_PLACEHOLDER}` : marker(a))),
    ...(needsInstruction(sent) ? [NOT_INLINED] : []),
  ]
    .filter(Boolean)
    .join("\n")
}

/** The message's text as the model reads it: what the user wrote, then what they attached. */
export function attachmentParts(text: string, attachments: Attachment[] = []): ContentPart[] {
  const sent = attachments.filter((attachment) => !attachment.host)
  const parts: ContentPart[] = text ? [{ type: "text", text }] : []
  for (const attachment of sent) parts.push({ type: "text", text: marker(attachment) })
  if (needsInstruction(sent)) parts.push({ type: "text", text: NOT_INLINED })
  return parts
}

/** A steer's own words: the wrapper Hermes sends it in off, and the files it carried off with it. */
export const steerWords = (content: string) => splitAttachments(steerText(content)).text

const MARKER = /^<attachment((?:\s+[a-z]+="[^"]*")*)\s*\/>$/

// A marker naming a type an image is what makes an attachment a photo: Hermes keeps a message's
// inline photos as `[screenshot]` lines wherever the parts fell, so those lines say how many there
// were and never which of the markers was one. The type is the file's own.
const IMAGE_TYPE = /^image\//i

// `[screenshot]` where an image part sat, or the same line carrying the detail the caller chose.
const SCREENSHOT_FORMS = [
  IMAGE_PLACEHOLDER,
  ...SCREENSHOT_DETAILS.map((detail) => IMAGE_PLACEHOLDER.replace(/\]$/, ` detail=${detail}]`)),
]

/** Where an `[Image attached …]` line points, and whether that is a copy on this host. */
const HINTS: [prefix: string, local: boolean][] = [
  [IMAGE_ATTACHED_AT, true],
  [IMAGE_ATTACHED, false],
]

function hintOf(line: string): { ref: string; local: boolean } | undefined {
  for (const [prefix, local] of HINTS) {
    if (!line.startsWith(prefix) || !line.endsWith("]")) continue
    const ref = line.slice(prefix.length, -1).trim()
    if (ref) return { ref, local }
  }
  return undefined
}

/**
 * Splits a transcript row's text back into what the user typed and what they attached. The lines
 * Hermes writes around a message's parts sit in one trailing block and are dropped: the "not
 * inlined" sentence, a `[screenshot]` line per photo, and a `[Image attached …]` line naming the copy
 * it committed — which the host appends to the message's first text part, so it lands with the
 * message's words, above the marker lines here. The markers are the attachments, whatever their
 * order.
 */
export function splitAttachments(content: string): { text: string; attachments: Attachment[] } {
  const lines = content.split("\n")
  const attachments: Attachment[] = []
  const hints: { path: string; at: number }[] = []
  // A hint is the host's only where the row also keeps its placeholder: one `[screenshot]` line is
  // written per inline photo, so an `[Image attached …]` line with none in the row is a message
  // quoting the host.
  let placeholders: boolean | undefined
  const hostPhotos = () =>
    (placeholders ??= lines.some((line) => SCREENSHOT_FORMS.includes(line.trim())))
  let end = lines.length
  const consumed = () => end < lines.length
  while (end > 0) {
    const line = lines[end - 1].trim()
    // The host separates what it adds from the message's words with a blank line.
    if (!line && consumed()) {
      end--
      continue
    }
    if (line === NOT_INLINED || SCREENSHOT_FORMS.includes(line)) {
      end--
      continue
    }
    const maybe = HINTS.some(([prefix]) => line.startsWith(prefix))
    const hint = maybe && hostPhotos() ? hintOf(line) : undefined
    if (hint) {
      if (hint.local) hints.unshift({ path: hint.ref, at: end - 1 })
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
    const size = Number(attrs.size)
    const type = attrs.type || UNNAMED_TYPE
    attachments.unshift({
      id: `${end}`,
      name: attrs.name || "file",
      type,
      size: Number.isFinite(size) && size > 0 ? size : 0,
      image: IMAGE_TYPE.test(type),
      path: attrs.path || undefined,
    })
    end--
  }
  // A row carrying no marker of its own still drew its photos: the hint's path is where they lie.
  if (!attachments.length)
    for (const hint of hints)
      attachments.push({
        id: `${hint.at}`,
        name: fileNameOf(hint.path),
        type: UNNAMED_TYPE,
        size: 0,
        image: true,
        host: true,
        path: hint.path,
      })
  return attachments.length || consumed()
    ? { text: lines.slice(0, end).join("\n"), attachments }
    : { text: content, attachments }
}
