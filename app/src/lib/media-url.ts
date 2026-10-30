import { cooldown } from "@/lib/cooldown"
import { connectionKey } from "@/lib/connection"
import { db } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getPluginFeatureList,
  getPluginMediaUrl,
  HermesError,
  type HermesConfig,
  type MediaUrlAnswer,
} from "@/lib/hermes"

/** Where one file can be read from: a URL the host signed, and what it is. */
export type MediaUrl = MediaUrlAnswer

/**
 * What asking the host for one file's URL answered. `gone` is the host saying it has no such file,
 * which settles the path; `unanswered` is a host that was out or a read that failed, which may
 * answer differently the next time it is asked.
 */
export type MediaAsk =
  { state: "ready"; read: MediaUrl } | { state: "gone" } | { state: "unanswered" }

/**
 * The URLs this page holds, one per bot and path, kept for the page's life: a URL is a string, and
 * nothing is fetched into the app behind it. The token in it is signed for minutes and minted
 * again when the app is opened again — not refreshed mid-page.
 */
const urls = new Map<string, MediaUrl>()
/** Paths the host answered it has no copy of, so a miss isn't asked for again. */
const gone = new Set<string>()
/** Asks under way, so a group of cells asks the host once each; each leaves on its own settle. */
const asking = new Map<string, Promise<MediaAsk>>()

const cacheKey = (config: HermesConfig, path: string) => `${config.baseUrl}\n${path}`

/** Asks the host for a URL for one path, saying whether its answer is the last word. */
function ask(config: HermesConfig, path: string): Promise<MediaAsk> {
  const key = cacheKey(config, path)
  const known = urls.get(key)
  if (known) return Promise.resolve({ state: "ready", read: known })
  if (gone.has(key)) return Promise.resolve({ state: "gone" })
  let pending = asking.get(key)
  if (!pending) {
    // A host that goes quiet must not leave a cell pulsing: the ask is bounded.
    pending = getPluginMediaUrl(config, path, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((read): MediaAsk => {
        urls.set(key, read)
        return { state: "ready", read }
      })
      .catch((error: unknown): MediaAsk => {
        // A 404 is the route saying it has no such file; a refused size is an answer about this
        // file too. Anything else said nothing about it.
        const settled =
          error instanceof HermesError && (error.status === 404 || error.status === 413)
        if (settled) gone.add(key)
        return settled ? { state: "gone" } : { state: "unanswered" }
      })
      .finally(() => {
        asking.delete(key)
      })
    asking.set(key, pending)
  }
  return pending
}

/** Bots whose plugin has no media route (an older plugin). */
const unsupported = cooldown()

/** The bot a chat belongs to, which is whose route a file is read through. */
async function hostOf(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  return profile ?? null
}

/**
 * The URL behind a file a message carries, or why there isn't one: a bot with no plugin, or one
 * from before the media route, is sat out for its cooldown rather than asked per file.
 */
export async function askMediaUrl(conversationId: string, path: string): Promise<MediaAsk> {
  const profile = await hostOf(conversationId)
  if (!profile) return { state: "gone" }
  const key = connectionKey(profile)
  if (unsupported.cooling(key)) return { state: "gone" }
  // One ask per server, kept for the page's life (and asked again when it fails), not one per
  // file: a group's files would otherwise ask about the plugin once each, as a reply streams.
  const features = await getPluginFeatureList(profile)
  // A host that was away never answered, which isn't the same as one without the route: it is
  // asked again rather than sat out for the route's cooldown.
  if (!features) return { state: "unanswered" }
  // A host from before the signed URL serves the file but can't sign for one: its media keeps the
  // fallback it had, a reply's tag as the text it came from, rather than a cell that never fills.
  if (!features.includes("media") || !features.includes("media_url")) {
    unsupported.start(key)
    return { state: "gone" }
  }
  unsupported.clear(key)
  return ask(profile, path)
}

/** That same ask, as where to read the file: null where the host can't serve it. */
export async function loadMediaUrl(conversationId: string, path: string): Promise<MediaUrl | null> {
  const answer = await askMediaUrl(conversationId, path)
  return answer.state === "ready" ? answer.read : null
}

/**
 * Lets go of what this page holds for one file, so the next ask goes to the host again: a cell
 * whose load failed keeps its place and offers exactly this.
 */
export async function forgetMediaUrl(conversationId: string, path: string) {
  const profile = await hostOf(conversationId)
  if (!profile) return
  const key = cacheKey(profile, path)
  urls.delete(key)
  gone.delete(key)
  asking.delete(key)
  unsupported.clear(connectionKey(profile))
}
