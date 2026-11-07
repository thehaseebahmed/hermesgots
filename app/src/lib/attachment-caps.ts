/**
 * What every intake surface takes, and what it says when a file won't fit: the composer's pick,
 * paste and drop, and the share screen. A pure rule with nothing imported but the type of the answer
 * a host gives, so `scripts/test-attachment-caps.mjs` runs it, and the words a refusal uses are
 * written once.
 */
import type { PluginFeatureAnswer } from "@/lib/features"

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
  limit: "count" | "file" | "inline" | "read" | "route"
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

/** A host's answer about a plugin feature its manifest either has or hasn't (see `features.ts`). */
export type RouteAnswer = PluginFeatureAnswer

export interface RoadFacts {
  readsImages: boolean
  route: RouteAnswer
}

/**
 * Why Files isn't offered on a host that answered `answer` about the plugin's file route, or null
 * where it is. Every surface that takes a file says it in these words — a sheet where no source can
 * reach the agent, and a paste or a drop of a file with no road.
 */
export function filesReason(answer: RouteAnswer): string | null {
  if (answer === "yes") return null
  return answer === "no"
    ? "File uploads need a newer Gots plugin."
    : "File uploads need the Gots plugin."
}

/** Where a pick travels: the bytes the model reads, the host's file route, or nowhere at all. */
export type PickRoad = { road: "inline" } | { road: "file" } | { road: "none"; message: string }

export function pickRoad({
  picture,
  readsImages,
  route,
}: RoadFacts & { picture: boolean }): PickRoad {
  // Only a host that answered `no` shuts the file road: an answer not read yet is not a no.
  const answeredNo = route === "no"
  if (picture && readsImages) return { road: "inline" }
  if (picture && !answeredNo) return { road: "file" }
  const because = filesReason(route)
  return because ? { road: "none", message: because } : { road: "file" }
}

export function ridesInline(file: CappedFile, facts: RoadFacts): boolean {
  return pickRoad({ ...facts, picture: isPhoto(file.type) }).road === "inline"
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
 * Whether an attachment carries the bytes the model is sent in the message itself: the one fact that
 * makes it a part. `inline` is that fact, never `image`, which says only what the file is — so every
 * reader of "does this ride inline" asks here rather than testing the field itself.
 */
export function carriesPart<T extends { inline?: unknown }>(
  attachment: T,
): attachment is T & { inline: NonNullable<T["inline"]> } {
  return Boolean(attachment.inline)
}

export function intake<T extends CappedFile>(files: T[], held = 0): Intake<T> {
  const room = Math.max(0, MAX_ATTACHMENTS - held)
  const chosen = files.slice(0, room)
  const left = files.length - chosen.length
  const refusals = left > 0 ? [countRefusal(left)] : []
  const take: T[] = []
  for (const file of chosen) {
    if (!isPhoto(file.type) && file.size > MAX_FILE_BYTES) refusals.push(sizeRefusal(file.name))
    else take.push(file)
  }
  return { take, refusals }
}

/** What an image keeps: the bytes it holds on this device, and the bytes the model is sent. */
export type KeptImage<B> = { kept: B; inline: B }

export function keptImage<B extends { size: number }>(file: B, scaled: B | null): KeptImage<B> {
  if (scaled && file.size > MAX_FILE_BYTES) return { kept: scaled, inline: scaled }
  return { kept: file, inline: scaled ?? file }
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
