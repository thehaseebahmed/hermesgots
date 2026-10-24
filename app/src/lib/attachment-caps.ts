/**
 * What every intake surface takes, and what it says when a file won't fit: the composer's pick,
 * paste and drop, and the share screen. A pure rule with nothing imported, so
 * `scripts/test-attachment-caps.mjs` runs it, and the words a refusal uses are written once.
 */

/** Under the API server's 10 MB request cap, which the plugin's upload shares. */
export const MAX_FILE_BYTES = 9 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
/** Photos go inline as base64 (a third bigger), so together they must leave the request room. */
export const MAX_INLINE_BYTES = 6.5 * 1024 * 1024
/** A paste and the drop it can also fire carry the same file; this long apart is one intake. */
const REPEAT_MS = 1000
// SVG isn't something providers take as an image, so it goes as a file.
const PHOTO_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/

/** The little a surface knows of a file before it reads it. */
export interface CappedFile {
  name: string
  size: number
  type: string
  lastModified?: number
}

/** A limit a surface broke, and the line that names it. */
export interface Refusal {
  limit: "count" | "file" | "inline" | "read"
  message: string
}

export interface Intake<T extends CappedFile = CappedFile> {
  /** What the message can take, in the order it arrived. */
  take: T[]
  /** One line per limit broken, ready to show. */
  refusals: Refusal[]
}

/** Whether a photo is read and scaled, rather than sent as the file it is. */
export const isPhoto = (type: string) => PHOTO_TYPES.test(type)

/**
 * Why Files isn't offered on a host that answered `answer` about the plugin's file route, or null
 * where it is. Every surface that takes a file says it in these words — the menu, and a paste or a
 * drop that arrives while the menu's Files is off.
 */
export function filesReason(answer: "unknown" | "yes" | "no"): string | null {
  if (answer === "yes") return null
  return answer === "no"
    ? "File uploads need a newer Gots plugin."
    : "File uploads need the Gots plugin."
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

export const sizeRefusal = (name: string): Refusal => ({
  limit: "file",
  message: `${name} is over the ${formatBytes(MAX_FILE_BYTES)} limit.`,
})

export const countRefusal = (left: number): Refusal => ({
  limit: "count",
  message: `A message can carry ${MAX_ATTACHMENTS} attachments, so ${left === 1 ? "1 was" : `${left} were`} left out.`,
})

export const inlineRefusal = (name: string): Refusal => ({
  limit: "inline",
  message: `${name} doesn't fit: a message's photos can add up to ${formatBytes(MAX_INLINE_BYTES)}. Send it in the next one.`,
})

export const unreadableRefusal = (name: string): Refusal => ({
  limit: "read",
  message: `Gots couldn't read ${name} from that share.`,
})

/** Whether a photo's bytes still leave the message's inline room, which only a read file knows. */
export const fitsInline = (size: number, used: number) => used + size <= MAX_INLINE_BYTES

/**
 * What a pick of `files` becomes on a message already holding `held` attachments. A photo that
 * goes inline is taken however big it arrived, since scaling is what makes it fit; anything else
 * is measured against the per-file cap before it is read.
 */
export function intake<T extends CappedFile>(
  files: T[],
  held = 0,
  { inline = true }: { inline?: boolean } = {},
): Intake<T> {
  const room = Math.max(0, MAX_ATTACHMENTS - held)
  const chosen = files.slice(0, room)
  const left = files.length - chosen.length
  const refusals = left > 0 ? [countRefusal(left)] : []
  const take: T[] = []
  for (const file of chosen) {
    const scales = inline && isPhoto(file.type)
    if (!scales && file.size > MAX_FILE_BYTES) refusals.push(sizeRefusal(file.name))
    else take.push(file)
  }
  return { take, refusals }
}

/** What an image keeps: the file itself, and the scaled copy too where the model reads one. */
export type KeptImage<B> = { kept: B; inline?: B }

/**
 * The bytes an image attachment keeps — the file the user chose, which is what the host stores and
 * this device caches — and the scaled copy the model reads where scaling made one.
 */
export function keptImage<B extends { size: number }>(file: B, scaled: B | null): KeptImage<B> {
  if (!scaled || scaled === file) return { kept: file }
  if (file.size <= MAX_FILE_BYTES) return { kept: file, inline: scaled }
  return { kept: scaled }
}

/**
 * The files `seen` hasn't taken moments ago, recorded as they are taken. A surface that hears both
 * a paste and the drop of the same file adds it once; `repeat: false` is an explicit pick, which
 * lands however recently the same file was taken, and is recorded all the same so a paste that
 * follows it is still one copy.
 */
export function fresh<T extends CappedFile>(
  files: T[],
  seen: Map<string, number>,
  now: number,
  { repeat = true }: { repeat?: boolean } = {},
): T[] {
  const took: T[] = []
  for (const file of files) {
    const key = `${file.name}:${file.size}:${file.lastModified ?? 0}`
    const at = seen.get(key)
    seen.set(key, now)
    if (repeat && at !== undefined && now - at < REPEAT_MS) continue
    took.push(file)
  }
  return took
}
