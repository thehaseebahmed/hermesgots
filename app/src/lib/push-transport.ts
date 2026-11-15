/**
 * How a device's notifications reach it, as one rule: the transports a build can offer, the one in
 * use, and what each can do — so a screen asks the transport rather than the platform.
 *
 * Three exist. A browser has Web Push and nothing else. The Android app has Firebase where the APK
 * was built with it, and ntfy always: the plugin publishes to a topic the user's ntfy app is
 * subscribed to, which needs nothing built into the APK, so a build without Firebase still notifies.
 *
 * What differs between them is who holds a category's switch. Firebase's are Android channels, which
 * only the phone's own settings switch (`system`). Web Push and ntfy have no channel per category —
 * ntfy's app has one per *priority* — so the app's own list is the switch and the sender enforces it
 * (`app`). Import-free, so `scripts/test-push-transport.mjs` runs it as a pure rule.
 */

export type PushTransportId = "webpush" | "firebase" | "ntfy"

export interface PushTransportInfo {
  id: PushTransportId
  title: string
  /** The line a pick shows under the name. */
  detail: string
  /** Who switches a category: the app's own list, or the phone's settings. */
  categories: "app" | "system"
  /** Whose permission stands between the switch and a notification; ntfy's is the ntfy app's own. */
  permission: "browser" | "phone" | "none"
}

export const PUSH_TRANSPORTS: Record<PushTransportId, PushTransportInfo> = {
  webpush: {
    id: "webpush",
    title: "Web Push",
    detail: "Through this browser",
    categories: "app",
    permission: "browser",
  },
  firebase: {
    id: "firebase",
    title: "Firebase",
    detail: "Through Google, shown by this app",
    categories: "system",
    permission: "phone",
  },
  ntfy: {
    id: "ntfy",
    title: "ntfy",
    detail: "Through an ntfy server, shown by the ntfy app",
    categories: "app",
    permission: "none",
  },
}

/** What this build is: the Android app or a page, and what was built into it. */
export interface PushEnv {
  native: boolean
  /** Whether the APK carries a Firebase configuration. */
  firebase: boolean
  /** Whether the browser has the Push API. */
  web: boolean
}

/** The transports this build offers, the default first: Firebase where the APK has it, else ntfy. */
export function transportsFor(env: PushEnv): PushTransportId[] {
  if (!env.native) return env.web ? ["webpush"] : []
  return env.firebase ? ["firebase", "ntfy"] : ["ntfy"]
}

/**
 * The transport in use: the one the user picked where this build still offers it, else the build's
 * default — so an install that predates the pick stays on Firebase, and a pick of Firebase carried
 * onto a build without it falls to ntfy rather than to nothing.
 */
export function activeTransport(env: PushEnv, picked?: string): PushTransportId | undefined {
  const offered = transportsFor(env)
  return offered.find((id) => id === picked) ?? offered[0]
}

export const NTFY_DEFAULT_SERVER = "https://ntfy.sh"

/** What a bot's host holds about where it publishes: everything but the token, which is a boolean. */
export interface NtfyState {
  configured: boolean
  /** Hermes's `NTFY_SERVER_URL`, or ntfy.sh where the profile names none. */
  server?: string
  /** Whether the profile names a server of its own rather than the default. */
  server_set?: boolean
  topic?: string | null
  /** Whether Hermes holds an `NTFY_TOKEN`: the token itself never leaves the host. */
  token_set?: boolean
  categories?: string[] | null
  /** How many phones chose ntfy for this bot. */
  devices?: number
  /** Whether the phone that asked is one of them. */
  joined?: boolean
}

/**
 * A server's address as it is published to — a scheme (https where none is typed), a host, any path
 * it sits under, no trailing slash — or nothing where it isn't one. Any server is taken: whether the
 * bot's host can reach it is the host's own network's business, and its answer is what the screen says.
 */
export function ntfyServer(value: string): string | undefined {
  const typed = value.trim()
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  if (!url.hostname || url.search || url.hash || url.username || url.password) return undefined
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`
}

/** ntfy's own rule for a topic: letters, digits, `-` and `_`, 64 at most. */
export const ntfyTopicOk = (topic: string) => /^[-_A-Za-z0-9]{1,64}$/.test(topic)

const TOPIC_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/**
 * A topic nobody can guess: on ntfy the name is half the secret. 22 characters of 62 is about 131
 * bits; a byte over 247 is drawn again so no letter is likelier than another.
 */
export function mintTopic(random: (count: number) => Uint8Array): string {
  let name = ""
  while (name.length < 22) {
    for (const byte of random(32)) {
      if (byte >= 248 || name.length >= 22) continue
      name += TOPIC_ALPHABET[byte % 62]
    }
  }
  return `gots-${name}`
}

/** A token as a header can carry it: no spaces, as ntfy's `tk_…` tokens are. */
export const ntfyTokenOk = (token: string) => /^[\x21-\x7e]{1,512}$/.test(token)

/**
 * Each category's importance as ntfy's priority. The numbers are the same on purpose — Android's 4
 * peeks and so does ntfy's `high`, 3 sounds as `default` does, 2 is silent as `low` is — and that is
 * all of a channel that survives: a category's own sound, and its own switch on the phone, do not.
 */
export function ntfyPriorities(categories: { id: string; importance: number }[]) {
  return Object.fromEntries(categories.map((category) => [category.id, category.importance]))
}
