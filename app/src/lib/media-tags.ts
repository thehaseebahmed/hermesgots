import { boundedStore } from "@/lib/bounded-cache"
import { connectionKey } from "@/lib/connection"
import { cooldown } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { getPluginFeatureList, getPluginMedia, type HermesConfig } from "@/lib/hermes"

export { mediaImages, type MediaPart } from "@/lib/media-parts"

/** A file a `MEDIA:<path>` tag named, once the host answered: where the page reads it, and what it is. */
export interface MediaFile {
  /** This page's handle on the bytes. */
  url: string
  /** The type the route served, empty where it named none. */
  type: string
  size: number
  /** The bytes themselves, so a save hands them over without asking the route again. */
  blob: Blob
}

/** How many files a page keeps: a chat read through for a while would otherwise pin every one. */
const MEDIA_LIMIT = 128
/** The files read already, so a redraw of a tag costs nothing. */
const files = boundedStore<MediaFile>({
  limit: MEDIA_LIMIT,
  // Letting go of the URL lets go of the bytes pinned behind it.
  dispose: (file) => URL.revokeObjectURL(file.url),
})
/** Reads under way, so a group of tags asks the route once each; each leaves on its own settle. */
const reading = new Map<string, Promise<MediaFile | null>>()

/** The file a `MEDIA:<path>` tag names, or null when the host can't serve it. */
export function getMediaFile(config: HermesConfig, path: string): Promise<MediaFile | null> {
  const key = `${config.baseUrl}\n${path}`
  const known = files.get(key)
  if (known) return Promise.resolve(known)
  let pending = reading.get(key)
  if (!pending) {
    // A host that goes quiet must not leave a cell pulsing: the read is bounded.
    pending = getPluginMedia(config, path, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((blob) => {
        const file = {
          url: URL.createObjectURL(blob),
          type: blob.type,
          size: blob.size,
          blob,
        }
        // The store's copy is the page's, so a file kept nowhere else still has its URL let go.
        if (!files.has(key)) files.set(key, file)
        else URL.revokeObjectURL(file.url)
        return file
      })
      .catch(() => null)
      .finally(() => {
        reading.delete(key)
      })
    reading.set(key, pending)
  }
  return pending
}

/** Bots whose plugin has no media route (an older plugin). */
const unsupported = cooldown()

/**
 * The file behind a chat's `MEDIA:<path>` tag, or null when its bot can't serve it: no plugin, or one
 * from before the media route. Every kind is read the same way, and one read serves the whole thread.
 */
export async function loadMediaFile(
  conversationId: string,
  path: string,
): Promise<MediaFile | null> {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  if (!profile) return null
  const key = connectionKey(profile)
  if (unsupported.cooling(key)) return null
  // One ask per server, kept for the page's life (and asked again when it fails), not one per
  // file: a group's files would otherwise ask about the plugin once each, as a reply streams.
  const features = await getPluginFeatureList(profile)
  // A Host that was away never answered, which isn't the same as one without the route: it is
  // asked again rather than sat out for the route's cooldown.
  if (!features) return null
  if (!features.includes("media")) {
    unsupported.start(key)
    return null
  }
  unsupported.clear(key)
  return getMediaFile(profile, path)
}
