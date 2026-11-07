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

/** What a host answered about the plugin's upload route. */
export type RouteAnswer = "unknown" | "yes" | "no"

/**
 * The two facts an intake surface has before it reads a file: whether this chat's model takes image
 * input, and what the host answered about the plugin's upload route. With the file's own kind they
 * are all `pickRoad` asks.
 */
export interface RoadFacts {
  /** Whether the chosen model takes image input. */
  readsImages: boolean
  /** What the host answered about the plugin's upload route. */
  route: RouteAnswer
}

/**
 * Why Files isn't offered on a host that answered `answer` about the plugin's file route, or null
 * where it is. Every surface that takes a file says it in these words — the menu, and a paste or a
 * drop that arrives while the menu's Files is off.
 */
export function filesReason(answer: RouteAnswer): string | null {
  if (answer === "yes") return null
  return answer === "no"
    ? "File uploads need a newer Gots plugin."
    : "File uploads need the Gots plugin."
}

/** Where a pick travels: the bytes the model reads, the host's file route, or nowhere at all. */
export type PickRoad = { road: "inline" } | { road: "file" } | { road: "none"; message: string }

/**
 * Which road a pick takes. A picture the model reads rides inline and needs no upload route. A
 * picture the model can't read travels as the file it is, on the host's route — and while the host
 * hasn't answered about that route it is tried all the same, since an answer not read yet is not a
 * no and the send is where a host that won't take it says why (Q2 of the spec). Any other pick — a
 * document, a clip — needs the route confirmed: a host that hasn't answered one carries it nowhere,
 * so it is refused in the sentence Files already gives, since it is the same missing capability.
 */
export function pickRoad({
  picture,
  readsImages,
  route,
}: RoadFacts & {
  /** Whether the pick is a picture this app would send as an image (`isPhoto`). */
  picture: boolean
}): PickRoad {
  if (picture && readsImages) return { road: "inline" }
  if (picture && route !== "no") return { road: "file" }
  const because = filesReason(route)
  return because ? { road: "none", message: because } : { road: "file" }
}

/**
 * Whether one file rides inline — the road rule, asked of that file. The read that prepares it hands
 * this answer to `prepareAttachment`, so each file in a batch is read by the road it takes; the caps
 * no longer ask it, since a picture is taken at any size on either road.
 */
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
 * What a pick of `files` becomes on a message already holding `held` attachments. A picture is taken
 * however big it arrives: scaling is what makes it fit, inline for the model or on the host's file
 * road where the copy the host is handed is scaled the same way, so a photo the browser can't decode
 * at all is refused by its size where it is read, not here. Anything else — a document, a clip — is
 * measured against the per-file cap before it is read.
 */
export function intake<T extends CappedFile>(files: T[], held = 0): Intake<T> {
  const room = Math.max(0, MAX_ATTACHMENTS - held)
  const chosen = files.slice(0, room)
  const left = files.length - chosen.length
  const refusals = left > 0 ? [countRefusal(left)] : []
  const take: T[] = []
  for (const file of chosen) {
    // A picture is never measured here: scaling makes it fit on either road, and the read that
    // cannot scale one refuses it by its size.
    if (!isPhoto(file.type) && file.size > MAX_FILE_BYTES) refusals.push(sizeRefusal(file.name))
    else take.push(file)
  }
  return { take, refusals }
}

/** What an image keeps: the bytes it holds on this device, and the bytes the model is sent. */
export type KeptImage<B> = { kept: B; inline: B }

/**
 * The bytes an image attachment keeps — the file the user chose, which is what the host stores and
 * this device caches — and the bytes the model is sent: the file itself where nothing was scaled,
 * else the scaled copy. An original past the per-file cap can't be the copy kept, so the scaled copy
 * stands in for both.
 */
export function keptImage<B extends { size: number }>(file: B, scaled: B | null): KeptImage<B> {
  if (!scaled || scaled === file) return { kept: file, inline: file }
  if (file.size <= MAX_FILE_BYTES) return { kept: file, inline: scaled }
  return { kept: scaled, inline: scaled }
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
