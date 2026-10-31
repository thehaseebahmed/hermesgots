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
import { cachedMedia, forgetCached } from "@/lib/media-cache"
import { mediaSpent } from "@/lib/media-expiry"
import { noteFailure } from "@/lib/report"

/** Where one file can be read from: a URL the host signed, and what it is. */
export type MediaUrl = MediaUrlAnswer & {
  /** The copy this device keeps, rather than a URL the host signed: it has no signature to outlive. */
  copy?: boolean
}

/**
 * What asking the host for one file's URL answered. `gone` is the host saying it has no such file,
 * which settles the path; `unanswered` is a host that was out or a read that failed, which may
 * answer differently the next time it is asked.
 */
export type MediaAsk =
  | { state: "ready"; read: MediaUrl }
  | { state: "gone" }
  | { state: "refused"; note: string }
  | { state: "unanswered" }

/**
 * The URLs this page holds, one per bot and path, each with the moment it runs out: a URL the host
 * signed is drawn from only while its signature is worth it, and another is minted when it is not,
 * because a page outlives the ten minutes a URL lives for (ADR 0075).
 */
const urls = new Map<string, MediaUrl>()
/** Paths the host answered it has no copy of, so a miss isn't asked for again. */
const gone = new Set<string>()
/** Asks under way, so a group of cells asks the host once each; each leaves on its own settle. */
const asking = new Map<string, Promise<MediaAsk>>()

const cacheKey = (config: HermesConfig, path: string) => `${config.baseUrl}\u0000${path}`

/**
 * Asks the host for a URL for one path, saying whether its answer is the last word. A URL this page
 * already holds is answered with itself unless its signature has run out: what is kept is worth
 * drawing from, and one that isn't is asked for again here rather than left to break a cell.
 */
function ask(config: HermesConfig, path: string): Promise<MediaAsk> {
  const key = cacheKey(config, path)
  const known = urls.get(key)
  if (known && !mediaSpent(known.expires)) return Promise.resolve({ state: "ready", read: known })
  if (known) urls.delete(key)
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
        // The route saying it has no such file settles the path; a refusal answers about a file it
        // does have, so its sentence — the file's name and the limit it met — is kept for the retry.
        if (error instanceof HermesError && error.status === 404) {
          gone.add(key)
          return { state: "gone" }
        }
        if (error instanceof HermesError && error.status === 413)
          return { state: "refused", note: error.message }
        noteFailure(`asking for the URL of ${path}`, error)
        return { state: "unanswered" }
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
 * What settles an ask without reaching the host, or `null` where the host can sign for one: a bot
 * with no plugin, or one from before the media route, is sat out for its cooldown rather than asked
 * per file. One ask about the plugin per server, kept for the page's life (and asked again when it
 * fails), because a group's files would otherwise ask once each as a reply streams.
 */
async function refusal(profile: { baseUrl: string; apiKey: string }): Promise<MediaAsk | null> {
  const key = connectionKey(profile)
  if (unsupported.cooling(key)) return { state: "gone" }
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
  return null
}

/**
 * Where a thread draws one file from. The copy this device keeps is the whole answer, and it is
 * read before the host is asked anything at all — no mint, no network, the same picture with the
 * host away — so a file this device doesn't hold is the only one that goes to the plugin. Nothing
 * comes back spent either way: a URL is answered only while its signature is worth drawing from.
 */
async function answerFor(
  profile: NonNullable<Awaited<ReturnType<typeof hostOf>>>,
  path: string,
): Promise<MediaAsk> {
  const held = await cachedMedia(profile.baseUrl, path)
  if (held) return { state: "ready", read: { ...held, expires: null, copy: true } }
  const refused = await refusal(profile)
  if (refused) return refused
  return ask(profile, path)
}

/**
 * Where a thread draws each of its files from, asked as one batch: the bot a chat belongs to is read
 * once for the whole group rather than once per file, which is what a message of several photos
 * would otherwise cost per cell.
 */
export async function askMediaUrls(conversationId: string, paths: string[]): Promise<MediaAsk[]> {
  const profile = await hostOf(conversationId)
  if (!profile) return paths.map(() => ({ state: "gone" as const }))
  return Promise.all(paths.map((path) => answerFor(profile, path)))
}

/**
 * The host's own URL for one file, never the copy this device keeps: where a file is handed over — a
 * download, a preview the platform opens — the host names it in how it serves it, which a kept copy
 * cannot.
 */
export async function loadHostMediaUrl(
  conversationId: string,
  path: string,
): Promise<MediaUrl | null> {
  const profile = await hostOf(conversationId)
  if (!profile) return null
  const refused = await refusal(profile)
  if (refused) return null
  const answer = await ask(profile, path)
  return answer.state === "ready" ? answer.read : null
}

/**
 * The bot's own address, which is what this device's copies of its files are keyed by: a photo's
 * bytes and a clip's frame are kept under it, so a cell draws them without a URL to key them by.
 */
export async function mediaServer(conversationId: string) {
  const profile = await hostOf(conversationId)
  return profile?.baseUrl
}

/**
 * Lets go of what this page holds for one file, and of the copy this device kept of it, so the next
 * ask goes to the host again: a cell whose load failed keeps its place and offers exactly this.
 */
export async function forgetMediaUrl(conversationId: string, path: string) {
  const profile = await hostOf(conversationId)
  if (!profile) return
  const key = cacheKey(profile, path)
  urls.delete(key)
  gone.delete(key)
  asking.delete(key)
  unsupported.clear(connectionKey(profile))
  await forgetCached(profile.baseUrl, path)
}
