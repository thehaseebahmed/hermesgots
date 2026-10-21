import { connectionKey } from "@/lib/connection"
import { cooldown } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { getPluginMedia, hasPluginFeature, type HermesConfig } from "@/lib/hermes"

export { mediaImages, type MediaPart } from "@/lib/media-parts"

/** One shared fetch per image: a chat re-renders constantly while a reply streams in. */
const images = new Map<string, Promise<string | null>>()

/** An image the agent named with a `MEDIA:<path>` tag, as an object URL, or null when it can't load. */
export function getMediaImage(config: HermesConfig, path: string): Promise<string | null> {
  const key = `${config.baseUrl}\n${path}`
  let pending = images.get(key)
  if (!pending) {
    // A host that goes quiet must not leave the image's place pulsing: the read is bounded.
    pending = getPluginMedia(config, path, AbortSignal.timeout(READ_TIMEOUT_MS))
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
  const key = connectionKey(profile)
  if (unsupported.cooling(key)) return null
  // One ask per server, kept for the page's life (and asked again when it fails), not one per
  // image: a gallery's images would otherwise ask about the plugin once each, as a reply streams.
  if (!(await hasPluginFeature(profile, "media"))) {
    unsupported.start(key)
    return null
  }
  unsupported.clear(key)
  return getMediaImage(profile, path)
}
