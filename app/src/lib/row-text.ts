/**
 * A row's `content` read as text the way the host reads it (`_coerce_message_text` in
 * `tui_gateway/session_history.py`). ADR 0142.
 */

/** A part of a row's words, or the one dict a row's whole content can be. */
export type RowPart = Record<string, unknown>

/** What the host stores as a row's `content`: a string, a parts list, one dict, or nothing. */
export type RowContent = string | RowPart | (RowPart | string)[] | null

const TEXT_KINDS = new Set(["text", "input_text", "output_text"])
const IMAGE_KINDS = new Set(["image_url", "input_image", "image"])
const AUDIO_KINDS = new Set(["input_audio", "audio"])

const isPart = (value: unknown): value is RowPart =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const kindOf = (part: RowPart) => (part.type ? String(part.type) : undefined)

const textIn = (value: unknown) => (value ? String(value) : "")

function dictText(part: RowPart): string {
  const kind = kindOf(part)
  if (kind && TEXT_KINDS.has(kind)) return textIn(part.text) || textIn(part.content)
  if (kind && IMAGE_KINDS.has(kind)) return "[image]"
  if (kind && AUDIO_KINDS.has(kind)) return "[audio]"
  if (kind) return `[${kind}]`
  return "text" in part ? textIn(part.text) : "[structured content]"
}

function listText(parts: readonly unknown[]): string {
  let text = ""
  for (const part of parts) {
    if (typeof part === "string") {
      text += part
      continue
    }
    if (!isPart(part)) continue
    if (typeof part.text === "string") {
      text += part.text
      continue
    }
    const kind = kindOf(part)
    if (!kind) continue
    text += TEXT_KINDS.has(kind) ? dictText(part) : `\n${dictText(part)}`
  }
  return text
}

function partWords(part: RowPart): string {
  const kind = kindOf(part)
  if (!kind) return textIn(part.text)
  return TEXT_KINDS.has(kind) ? dictText(part) : ""
}

function listWords(parts: readonly unknown[]): string {
  let text = ""
  for (const part of parts) {
    if (typeof part === "string") text += part
    else if (isPart(part)) text += partWords(part)
  }
  return text
}

export function rowText(content: unknown): string {
  if (Array.isArray(content)) return listText(content)
  if (isPart(content)) return dictText(content)
  return content === null || content === undefined ? "" : String(content)
}

export function rowWords(content: unknown): string {
  if (Array.isArray(content)) return listWords(content)
  if (isPart(content)) return partWords(content)
  return content === null || content === undefined ? "" : String(content)
}
