/**
 * The `user` row Hermes keeps for a message that carried photos: the parts joined, each inline image
 * kept as the `[screenshot]` line it became, and one hint line per photo on the message's own words,
 * naming the copy the host committed (`restore_api_images` in `gateway/session_api_media.py`, joined
 * by `agent/session_persistence._durable_content`). Both test hosts write their rows through here.
 */
import { createHash } from "node:crypto"

// What the host commits a photo to: its bytes' digest, under the type its bytes are.
const COMMITTED = "/opt/data/cache/documents/native-inputs"

// The types `commit_api_images` accepts, read off the bytes it sniffs rather than a client's label.
const ACCEPTED = [
  { ext: ".png", starts: (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) },
  { ext: ".jpg", starts: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ".gif", starts: (b) => b.subarray(0, 4).toString("ascii") === "GIF8" },
  {
    ext: ".webp",
    starts: (b) =>
      b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
]

const NO_WORDS = "What do you see in this image?"

/** The path the host commits this photo to. Bytes it doesn't accept refuse the request, as the host does. */
export function committedPhoto(url) {
  const [, encoded = ""] = String(url).split(",", 2)
  const bytes = Buffer.from(encoded, "base64")
  const accepted = ACCEPTED.find((each) => each.starts(bytes))
  if (!accepted) throw new Error("the host commits only PNG, JPEG, GIF and WebP bytes")
  const digest = createHash("sha256").update(bytes).digest("hex")
  return `${COMMITTED}/${digest}/api_${digest.slice(0, 32)}${accepted.ext}`
}

/**
 * A message's content parts as the host's row keeps them. The hints go on the first text part, so
 * they sit with the message's own words and above the markers the client wrote.
 */
export function durableUserRow(content) {
  const parts = []
  let first = null
  let photos = 0
  for (const part of content) {
    if (part?.type === "text") {
      const text = { text: part.text ?? "" }
      first ??= text
      parts.push(text)
    } else if (part?.type === "image_url") {
      const detail = part.detail ?? (part.image_url ?? {}).detail
      parts.push({ url: (part.image_url ?? {}).url ?? "", detail })
      photos++
    }
  }
  if (photos) {
    const hints = parts
      .filter((part) => part.url !== undefined)
      .map((part) => hintFor(part.url))
      .join("\n")
    if (!first) {
      first = { text: NO_WORDS }
      parts.unshift(first)
    }
    first.text = `${first.text}\n\n${hints}`
  }
  return parts
    .map((part) => (part.url === undefined ? part.text : shotMarker(part.detail)))
    .join("\n")
}

/** The placeholder one image part leaves behind, carrying the detail a caller chose on it. */
function shotMarker(detail) {
  return ["low", "high", "auto"].includes(detail) ? `[screenshot detail=${detail}]` : "[screenshot]"
}

/** The line the host writes for one photo: the copy it committed, or the address it was given. */
function hintFor(url) {
  return /^data:/i.test(url)
    ? `[Image attached at: ${committedPhoto(url)}]`
    : `[Image attached: ${url}]`
}
