/**
 * A row's words, as the host stores them and as the app reads them.
 *
 * `GET /api/sessions/{id}/messages` answers a row's `content` in one of three shapes: a plain
 * string, a list of parts (a message that carried a photo, or a tool result carrying an image), or
 * one structured dict. The host's own transcript read renders all three as text
 * (`_coerce_message_text` in `tui_gateway/session_history.py`), and this is that rule: a user's or
 * an assistant's words and a tool row's result both reach the thread through it, so every reader
 * after the fold holds a string. A part of a kind the app keeps no bytes for stands as the
 * placeholder the host itself draws, since the thread paints media from its own markers. Import-free,
 * so `scripts/test-row-text.mjs` runs it as a pure rule. ADR 0142.
 */

/** The kinds whose own words are their text, so they are joined without a line of their own. */
const TEXT_KINDS = new Set(["text", "input_text", "output_text"])
const IMAGE_KINDS = new Set(["image_url", "input_image", "image"])
const AUDIO_KINDS = new Set(["input_audio", "audio"])

const isPart = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The kind a part names, where it names one at all. */
const kindOf = (part: Record<string, unknown>) =>
  typeof part.type === "string" ? part.type : undefined

/** A field as words: the host reads a part's text from a string and from nothing else. */
const textIn = (value: unknown) => (typeof value === "string" ? value : "")

/** One structured dict — a part's own, or a row's whole content — read by the kind it names. */
function dictText(part: Record<string, unknown>): string {
  const kind = kindOf(part)
  if (kind && TEXT_KINDS.has(kind)) return textIn(part.text) || textIn(part.content)
  if (kind && IMAGE_KINDS.has(kind)) return "[image]"
  if (kind && AUDIO_KINDS.has(kind)) return "[audio]"
  if (kind) return `[${kind}]`
  return "text" in part ? textIn(part.text) : "[structured content]"
}

/** A parts list joined as the host joins it: text as it stands, every other part on its own line. */
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

/**
 * A row's `content` as the words the thread draws: a string as itself, a parts list joined, one
 * structured dict by its kind, and nothing at all for a row that holds no words.
 */
export function rowText(content: unknown): string {
  if (Array.isArray(content)) return listText(content)
  if (isPart(content)) return dictText(content)
  return content === null || content === undefined ? "" : String(content)
}
