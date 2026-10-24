/**
 * What a message tells the model about the files it carries, and how the thread reads them back:
 * one `<attachment>` marker line per file — its name, its type, its size and where the plugin saved
 * it — then, once, the sentence that the content itself is not included. Import-free but for types,
 * so `scripts/test-attachments.mjs` runs it as a pure rule.
 */
import type { Attachment } from "@/lib/db"
import type { ContentPart } from "@/lib/hermes"

/**
 * Told once per message, after the last marker: the bytes stay on the host, and the agent's own
 * file tools are what turn a path into content.
 */
export const NOT_INLINED =
  "The content of each file is not included in this message: open it on the host and extract the text yourself."

// What Hermes keeps of an inline image in its transcript.
const IMAGE_PLACEHOLDER = "[screenshot]"

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
  return [
    text,
    ...attachments.map((a) => (a.image ? `${marker(a)}\n${IMAGE_PLACEHOLDER}` : marker(a))),
    ...(needsInstruction(attachments) ? [NOT_INLINED] : []),
  ]
    .filter(Boolean)
    .join("\n")
}

/** The message's text as the model reads it: what the user wrote, then what they attached. */
export function attachmentParts(text: string, attachments: Attachment[] = []): ContentPart[] {
  const parts: ContentPart[] = text ? [{ type: "text", text }] : []
  for (const attachment of attachments) parts.push({ type: "text", text: marker(attachment) })
  if (needsInstruction(attachments)) parts.push({ type: "text", text: NOT_INLINED })
  return parts
}

const MARKER = /^<attachment((?:\s+[a-z]+="[^"]*")*)\s*\/>$/

/** Splits a transcript row's text back into what the user typed and what they attached. */
export function splitAttachments(content: string): { text: string; attachments: Attachment[] } {
  const lines = content.split("\n")
  const attachments: Attachment[] = []
  let end = lines.length
  if (lines[end - 1]?.trim() === NOT_INLINED) end--
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
    const size = Number(attrs.size)
    attachments.unshift({
      id: `${end}`,
      name: attrs.name || "file",
      type: attrs.type || "application/octet-stream",
      size: Number.isFinite(size) && size > 0 ? size : 0,
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

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}
