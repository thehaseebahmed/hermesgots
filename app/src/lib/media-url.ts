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
 * which settles the path; `unsupported` is a bot whose plugin predates the signed URL, which can
 * draw nothing either but is not the same thing to tell a reader who tapped one of its files;
 * `unanswered` is a host that was out or a read that failed, which may answer differently the next
 * time it is asked.
 */
export type MediaAsk =
  | { state: "ready"; read: MediaUrl }
  | { state: "gone" }
  | { state: "unsupported" }
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
 * The URL this page holds for one path, while its signature is worth drawing from. One that isn't is
 * let go of here rather than left to break a cell, so "is this URL still good" has one answer.
 */
function held(key: string): MediaUrl | undefined {
  const known = urls.get(key)
  if (!known) return undefined
  if (!mediaSpent(known.expires)) return known
  urls.delete(key)
  return undefined
}

/** Lets go of what this page remembers about one path: the URL it holds, and the miss it settled. */
function forget(key: string) {
  urls.delete(key)
  gone.delete(key)
}

/**
 * Asks the host for a URL for one path, saying whether its answer is the last word. A URL this page
 * already holds is answered with itself unless its signature has run out: what is kept is worth
 * drawing from, and one that isn't is asked for again here rather than left to break a cell.
 */
function ask(config: HermesConfig, path: string): Promise<MediaAsk> {
  const key = cacheKey(config, path)
  const known = held(key)
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
  if (unsupported.cooling(key)) return { state: "unsupported" }
  const features = await getPluginFeatureList(profile)
  // A host that was away never answered, which isn't the same as one without the route: it is
  // asked again rather than sat out for the route's cooldown.
  if (!features) return { state: "unanswered" }
  // A host from before the signed URL serves the file but can't sign for one: nothing it holds can
  // be drawn, so a reply's tag draws no cell at all (ADR 0111) — and a reader who tapped one of its
  // files is told the plugin is what's behind, not that the file is missing.
  if (!features.includes("media") || !features.includes("media_url")) {
    unsupported.start(key)
    return { state: "unsupported" }
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
 * cannot. `null` is every way the host can decline, which a caller with nothing to draw has no use
 * for; a caller that says what happened asks `askThreadMediaUrl` and keeps the difference.
 */
export async function loadHostMediaUrl(
  conversationId: string,
  path: string,
): Promise<MediaUrl | null> {
  const answer = await askThreadMediaUrl(conversationId, path)
  return answer.state === "ready" ? answer.read : null
}

/**
 * What the host answers for one file, asked through the bot a chat belongs to — the whole answer,
 * for a row that hands the file over and has to say what the host said (a size cap's own sentence,
 * a plugin too old to sign, a host that didn't reply) rather than guess at a missing file.
 */
export async function askThreadMediaUrl(conversationId: string, path: string): Promise<MediaAsk> {
  const profile = await hostOf(conversationId)
  // A chat this device no longer holds has no bot to ask: nothing was asked, so nothing is claimed.
  return profile ? askMediaUrl(profile, path) : { state: "unanswered" }
}

/**
 * What the host answers for one file, asked from a bot's own connection rather than a thread's: a
 * library lists files no chat carries, so a screen outside a thread names the bot it belongs to
 * instead. The whole answer comes back — a file the host has not got, one it refused and why, a host
 * that didn't reply — so the screen can say which of those it met rather than guess (ADR 0111).
 *
 * `again` forgets a miss this page remembered: a listing that named the path a moment ago knows
 * better than a 404 the page got before the file was written.
 */
export async function askMediaUrl(
  config: HermesConfig,
  path: string,
  { again = false }: { again?: boolean } = {},
): Promise<MediaAsk> {
  if (again) gone.delete(cacheKey(config, path))
  const refused = await refusal(config)
  if (refused) return refused
  return ask(config, path)
}

/**
 * The URL this page already holds for one file, while its signature is worth drawing from: a tap
 * that has one opens at once instead of dimming its row for a mint that never happens.
 */
export function heldMediaUrl(config: HermesConfig, path: string): MediaUrl | undefined {
  return held(cacheKey(config, path))
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
  forget(key)
  asking.delete(key)
  unsupported.clear(connectionKey(profile))
  await forgetCached(profile.baseUrl, path)
}

/**
 * What a reader is told when a tap's ask came back without a URL: one sentence per way that happens,
 * said here so a screen that hands a host file over and a row that shows one tell the same story —
 * and a new state is taught once rather than in each screen that taps.
 */
export function askNote(answer: Exclude<MediaAsk, { state: "ready" }>, name: string): string {
  if (answer.state === "refused") return answer.note
  if (answer.state === "unsupported") return `The bot's plugin is too old to open ${name}.`
  if (answer.state === "unanswered") return `The bot didn't answer for ${name}.`
  return `The bot has no ${name}.`
}
