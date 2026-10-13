import { cooldown } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { getPluginFeatures, getPluginMedia, type HermesConfig } from "@/lib/hermes"

export type MediaPart =
  { kind: "text"; at: number; text: string } | { kind: "media"; at: number; paths: string[] }

// Raster formats the plugin serves (its `MEDIA_TYPES` map), longest first like Hermes's own
// extension alternation.
const IMAGE_EXTS = "jpeg|png|jpg|gif|webp|bmp"
const CJK_TERMINATORS = "（）〈〉《》：，。；！？、“”‘’【】"
/**
 * The `MEDIA:<path>` tag shape Hermes's own `MEDIA_TAG_CLEANUP_RE` strips for messaging adapters,
 * narrowed to the image extensions, so a reply shows here exactly the images it would send there.
 */
const TAG = new RegExp(
  "[`\"'*_]{0,3}MEDIA:\\s*" +
    "(?<path>`[^`\\n]+?`|\"[^\"\\n]+?\"|'[^'\\n]+?'|" +
    "(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:" +
    IMAGE_EXTS +
    "))" +
    "(?=[\\s`\"'*_,;:)\\]\\[}" +
    CJK_TERMINATORS +
    "]|MEDIA:|\\.(?:\\s|$)|$)[`\"'*_]{0,3}\\.?",
  "gi",
)

function unquote(path: string) {
  const first = path[0]
  return path.length > 1 &&
    (first === "`" || first === '"' || first === "'") &&
    path.at(-1) === first
    ? path.slice(1, -1)
    : path
}

function scan(slice: string, at: number, parts: MediaPart[]) {
  let last = 0
  for (const match of slice.matchAll(TAG)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ kind: "text", at: at + last, text: slice.slice(last, index) })
    parts.push({
      kind: "media",
      at: at + index,
      paths: [unquote(match.groups?.path ?? "")],
    })
    last = index + match[0].length
  }
  if (last < slice.length) parts.push({ kind: "text", at: at + last, text: slice.slice(last) })
}

/** Tags sent together — only whitespace between them — come out as one part: a gallery. */
function group(parts: MediaPart[]): MediaPart[] {
  const grouped: MediaPart[] = []
  let run: { at: number; paths: string[] } | null = null
  for (const part of parts) {
    if (part.kind === "media") {
      if (run) run.paths.push(...part.paths)
      else run = { at: part.at, paths: [...part.paths] }
    } else if (part.text.trim()) {
      if (run) {
        grouped.push({ kind: "media", ...run })
        run = null
      }
      grouped.push(part)
    }
  }
  if (run) grouped.push({ kind: "media", ...run })
  return grouped
}

/**
 * Splits a reply into text and the images it names with `MEDIA:<path>` tags: each tag its own part,
 * and the tags sent together (only whitespace between) one gallery part. A tag inside a fenced code
 * block is an example, not an image, and stays in the text.
 */
export function mediaImages(text: string): MediaPart[] {
  const parts: MediaPart[] = []
  let offset = 0
  let plainFrom = 0
  let fence: string | null = null
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0] ?? null
    if (marker) {
      if (!fence) {
        scan(text.slice(plainFrom, offset), plainFrom, parts)
        fence = marker
      } else if (marker === fence) {
        fence = null
        plainFrom = offset + line.length + 1
      }
    }
    offset += line.length + 1
  }
  scan(text.slice(plainFrom), plainFrom, parts)
  return group(parts)
}

/** One shared fetch per image: a chat re-renders constantly while a reply streams in. */
const images = new Map<string, Promise<string | null>>()

/** An image the agent named with a `MEDIA:<path>` tag, as an object URL, or null when it can't load. */
export function getMediaImage(config: HermesConfig, path: string): Promise<string | null> {
  const key = `${config.baseUrl}\n${path}`
  let pending = images.get(key)
  if (!pending) {
    pending = getPluginMedia(config, path)
      .then((blob) => URL.createObjectURL(blob))
      .catch(() => null)
    images.set(key, pending)
  }
  return pending
}

/** Bots whose plugin has no media route (an older plugin). */
const unsupported = cooldown()

/**
 * The image behind a chat's `MEDIA:<path>` tag, as an object URL, or null when its bot can't serve
 * it: no plugin, or one from before the media route.
 */
export async function loadMediaImage(conversationId: string, path: string): Promise<string | null> {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  if (!profile) return null
  const key = `${profile.baseUrl}\n${profile.apiKey}`
  if (unsupported.cooling(key)) return null
  let features: string[]
  try {
    features = await getPluginFeatures(profile)
  } catch {
    unsupported.start(key)
    return null
  }
  if (!features.includes("media")) {
    unsupported.start(key)
    return null
  }
  unsupported.clear(key)
  return getMediaImage(profile, path)
}
