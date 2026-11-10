/**
 * How a thread draws a file, from what it is: one rule for what the user sends and for what an
 * agent returns, so a thread reads the same whoever wrote the media. Import-free, so
 * `scripts/test-media-kind.mjs` runs it as a pure rule.
 */

export type MediaKind = "image" | "video" | "audio" | "page" | "file"
/**
 * Where a kind draws: side by side in the Gallery, a recording's row, a page's row (a page has no
 * thumbnail worth painting, and a running page in a cell would run scripts for every message on
 * screen), or a row to download.
 */
export type MediaCell = "gallery" | "audio" | "page" | "file"

const CELLS: Record<MediaKind, MediaCell> = {
  image: "gallery",
  video: "gallery",
  audio: "audio",
  page: "page",
  file: "file",
}

// For a type that names no family — a generic binary, or nothing at all — the extension says it.
// The image list carries a phone's or a camera's own formats (HEIC, HEIF, ICO, TIFF), which the route
// hands over as a binary: the thread draws what the device can show and saves the rest, so a HEIC is
// a kind here and still a download row in `drawnCell`.
const KIND_EXTS: Record<Exclude<MediaKind, "file" | "page">, readonly string[]> = {
  image: [
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
  ],
  video: ["mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi"],
  audio: ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba"],
}
const IMAGE_EXTS = new Set(KIND_EXTS.image)
const VIDEO_EXTS = new Set(KIND_EXTS.video)
const AUDIO_EXTS = new Set(KIND_EXTS.audio)
// A page: HTML, the one text format the Previewer draws (as a sandboxed frame).
const PAGE_TYPES = new Set(["text/html"])
const PAGE_EXTS = new Set(["html", "htm"])

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

/** The extensions those types dress: `image/svg+xml` is an `.svg`, `video/x-m4v` an `.m4v`. */
const extOf = (type: string) => type.replace("+xml", "").split("/")[1].replace(/^x-/, "")
const DRAWN_IMAGE_EXTS = new Set([...DRAWN_IMAGES].map(extOf))

const FAMILY = /^(image|video|audio)\//

/** The family a type names, or nothing where it names none: a generic binary, or no type at all. */
const familyOf = (type?: string) => FAMILY.exec((type ?? "").trim().toLowerCase())?.[1]

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
  const family = familyOf(type)
  if (family) return family as MediaKind
  const named = (type ?? "").trim().toLowerCase().split(";")[0].trim()
  if (PAGE_TYPES.has(named)) return "page"
  const ext = extension(name)
  if (IMAGE_EXTS.has(ext)) return "image"
  if (VIDEO_EXTS.has(ext)) return "video"
  if (AUDIO_EXTS.has(ext)) return "audio"
  // Only where the type names nothing at all, or a generic binary: `text/plain` on a `.html` is
  // what its writer said it is.
  if (PAGE_EXTS.has(ext) && (!named || named === "application/octet-stream")) return "page"
  return "file"
}

/** Whether a browser draws this image itself, rather than needing a scaled copy of it. */
export function renderableImage(type?: string) {
  return DRAWN_IMAGES.has((type ?? "").trim().toLowerCase())
}

// The types a browser plays in a `<video>`: Chromium answers `canPlayType` for each of these and
// refuses `video/quicktime`, which is why a `.mov` goes to the platform with the rest.
const PLAYED_VIDEOS = new Set(["video/mp4", "video/webm", "video/ogg", "video/x-m4v"])

/** Whether a browser plays this clip itself, rather than handing it to the platform. */
export function playableVideo(type?: string) {
  return PLAYED_VIDEOS.has((type ?? "").trim().toLowerCase())
}

const PLAYED_VIDEO_EXTS = new Set([...PLAYED_VIDEOS].map(extOf))

/**
 * Where a file draws, from what it is: the cell the Gallery paints, or `file` for the row that hands
 * it to the platform. A cell only where the **Previewer** is the place — a kind it draws, and a photo
 * or a clip only where a browser draws or plays that type — so a phone's HEIC, a camera's MKV and an
 * archive get the row that downloads them rather than a cell that can never fill. The one rule a
 * reply's tags, a message's sent files and a screen listing the host's files read (ADR 0111).
 *
 * Where the type names no family at all — a generic binary, or nothing — the extension says what the
 * file is, and it says what a browser draws just as well, so a photo a picker typed loosely still
 * keeps its cell.
 */
export function drawnCell(type: string | undefined, name: string): MediaCell {
  const kind = mediaKind(type, name)
  const ext = extension(name)
  const fromExt = !familyOf(type)
  if (kind === "image" && !(renderableImage(type) || (fromExt && DRAWN_IMAGE_EXTS.has(ext))))
    return "file"
  if (kind === "video" && !(playableVideo(type) || (fromExt && PLAYED_VIDEO_EXTS.has(ext))))
    return "file"
  return CELLS[kind]
}
