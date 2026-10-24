/**
 * How a thread draws a file, from what it is: one rule for what the user sends and for what an
 * agent returns, so a thread reads the same whoever wrote the media. Images (an SVG too) and video
 * take a cell in the Gallery, audio a row of its own, and everything else a row that downloads.
 * Import-free, so `scripts/test-media-kind.mjs` runs it as a pure rule.
 */

export type MediaKind = "image" | "video" | "audio" | "file"
/** Where a kind draws: side by side in the Gallery, its own row, or a row to download. */
export type MediaCell = "gallery" | "audio" | "file"

const CELLS: Record<MediaKind, MediaCell> = {
  image: "gallery",
  video: "gallery",
  audio: "audio",
  file: "file",
}

// For a type that names no family — a generic binary, or nothing at all — the extension says it.
// The image list carries a phone's or a camera's own formats (HEIC, HEIF, ICO, TIFF), which the route
// hands over as a binary: the thread draws what the device can show and saves the rest.
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "svg",
  "heic",
  "heif",
  "ico",
  "tif",
  "tiff",
])
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi"])
const AUDIO_EXTS = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba"])

// Types a browser draws in an <img> as it is; a HEIC needs the scaled copy instead.
const DRAWN_IMAGES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/svg+xml",
])

const FAMILY = /^(image|video|audio)\//

/** The name a path ends in, which is how a thread names the file a message carries. */
export function fileNameOf(path: string) {
  return path.split(/[\\/]/).pop() || path
}

function extension(name?: string) {
  const base = fileNameOf(name ?? "")
  const dot = base.lastIndexOf(".")
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase()
}

/** What a file is, from its type and, where the type names no family, its name. */
export function mediaKind(type?: string, name?: string): MediaKind {
  const family = FAMILY.exec((type ?? "").trim().toLowerCase())?.[1]
  if (family) return family as MediaKind
  const ext = extension(name)
  if (IMAGE_EXTS.has(ext)) return "image"
  if (VIDEO_EXTS.has(ext)) return "video"
  if (AUDIO_EXTS.has(ext)) return "audio"
  return "file"
}

/** Where a file draws in a thread: the Gallery, a row of its own, or a row to download. */
export function mediaCell(type?: string, name?: string): MediaCell {
  return CELLS[mediaKind(type, name)]
}

/** Whether a browser draws this image itself, rather than needing a scaled copy of it. */
export function renderableImage(type?: string) {
  return DRAWN_IMAGES.has((type ?? "").trim().toLowerCase())
}
