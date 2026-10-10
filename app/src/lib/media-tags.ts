import { db } from "@/lib/db"
import { getPluginFeatures, getPluginMedia, type HermesConfig } from "@/lib/hermes"

export type MediaPart =
  | { kind: "text"; at: number; text: string }
  | { kind: "media"; at: number; path: string; raw: string }

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
      path: unquote(match.groups?.path ?? ""),
      raw: match[0],
    })
    last = index + match[0].length
  }
  if (last < slice.length) parts.push({ kind: "text", at: at + last, text: slice.slice(last) })
}

/**
 * Splits a reply into text and the images it names with `MEDIA:<path>` tags. A tag inside a fenced
 * code block is an example, not an image, and stays in the text.
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
  return parts
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

/** Bots whose plugin has no media route (an older plugin), and when one was last tried. */
const unsupported = new Map<string, number>()
const RETRY_MS = 5 * 60 * 1000

/**
 * The image behind a chat's `MEDIA:<path>` tag, as an object URL, or null when its bot can't serve
 * it: no plugin, or one from before the media route.
 */
export async function loadMediaImage(conversationId: string, path: string): Promise<string | null> {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  if (!profile) return null
  const key = `${profile.baseUrl}\n${profile.apiKey}`
  if (Date.now() - (unsupported.get(key) ?? -Infinity) < RETRY_MS) return null
  let features: string[]
  try {
    features = await getPluginFeatures(profile)
  } catch {
    unsupported.set(key, Date.now())
    return null
  }
  if (!features.includes("media")) {
    unsupported.set(key, Date.now())
    return null
  }
  unsupported.delete(key)
  return getMediaImage(profile, path)
}
