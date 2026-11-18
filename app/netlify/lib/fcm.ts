/**
 * Firebase Cloud Messaging from a Netlify function. The Android app can't use Web Push, and sending
 * through FCM takes a service account key, which can't live on every user's Hermes host. So a plugin
 * asks the registry to send (`push` in `registry.ts`) and the key stays here, in `FIREBASE_SERVICE_ACCOUNT` (the same key CI uses to reach App Distribution).
 * The message names the chat (or routine, or project) and says what happened, never what was asked.
 */

/**
 * What a push is about, and what a device switches. The plugin (`plugin/push.py`) and the app
 * (`src/lib/push-kinds.ts`) keep the same lists. The first three kinds wait on the user; the rest are
 * news. A category is a kind within a feature: a session's kinds belong to Code when it is a project
 * session, else to Chats. `test` is the Developer button's.
 */
export const PUSH_KINDS = [
  "approval",
  "question",
  "plan",
  "run_done",
  "run_failed",
  "clone_failed",
  "routine_failed",
  "research_brief",
  "research_scope",
  "research_done",
  "research_failed",
  "routine_message",
  "meeting_done",
  "meeting_failed",
  "room_input",
] as const
export type PushKind = (typeof PUSH_KINDS)[number] | "test"
export type SendResult = "ok" | "gone" | "error"

export const PUSH_CATEGORIES = [
  "chat_input",
  "chat_run_failed",
  "chat_run_done",
  "room_input",
  "code_input",
  "code_run_failed",
  "code_run_done",
  "code_setup_failed",
  "routine_failed",
  "routine_message",
  "research_input",
  "research_done",
  "research_failed",
  "meeting_done",
  "meeting_failed",
] as const
export type PushCategory = (typeof PUSH_CATEGORIES)[number]
/** What a device that never said which it wants gets: what pushed before there were more. */
export const LEGACY_CATEGORIES: readonly string[] = ["chat_input", "code_input"]

/** The category of a push from a plugin that predates them, which only sent the first three kinds. */
export function categoryOf(kind: PushKind): PushCategory | "test" {
  if (kind === "test") return "test"
  if (kind === "approval" || kind === "question") return "chat_input"
  if (kind === "plan") return "code_input"
  if (kind === "clone_failed") return "code_setup_failed"
  if (kind === "routine_failed") return "routine_failed"
  if (kind === "routine_message") return "routine_message"
  if (kind === "room_input") return "room_input"
  if (kind === "research_brief" || kind === "research_scope") return "research_input"
  if (kind === "research_done" || kind === "research_failed") return kind
  if (kind === "meeting_done" || kind === "meeting_failed") return kind
  return `code_${kind}`
}

/** One button a notice carries: what it says, and the link a press posts (`plugin/notice.py`). */
export interface PushAction {
  label: string
  url: string
}

/** What the plugin tells about a push beyond its kind (0.33): the chat's title, and what it says. */
export interface PushDetail {
  title?: string
  body?: string
  /** The bot's plain picture to draw, at the app's own origin; Android badges it itself. */
  icon?: string
  /** Whose picture it is, so a phone that can't fetch it falls back to the badge the APK ships. */
  bot?: string
  /** The buttons a tray may draw: an approval's two, and no other kind's. */
  actions?: PushAction[]
  /** The chat the notice is about, which the phone keys its conversation entry by. */
  chat?: string
  /** The one-shot link the tray's Reply posts its text to (`answers.reply_link` in the plugin). */
  reply?: string
  /** Whether the tray offers Mark as read on it: the plugin's word, on a chat's news alone. */
  read?: boolean
  /** The host's moment (ms) of the activity the notice reports: what a Mark as read covers. */
  at?: number
}

export interface FcmSender {
  send(
    token: string,
    kind: PushKind,
    category: string,
    sessionId: string,
    detail?: PushDetail,
  ): Promise<SendResult>
  /** A test message to one device: null when Firebase took it, else Google's own reason. */
  test(token: string): Promise<string | null>
}

interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

// What happened, under the title of what it happened in. `public/push-sw.js` says the same.
const WORDS: Record<PushKind, string> = {
  approval: "Waiting for your approval",
  question: "You have a question waiting",
  plan: "The plan is ready for your review",
  run_done: "You have a new reply",
  run_failed: "The run stopped with an error",
  clone_failed: "This project couldn't be set up",
  routine_failed: "The last run failed",
  research_brief: "The brief is ready for your review",
  research_scope: "The scope is ready for your approval",
  research_done: "Your research is ready",
  research_failed: "The mission stopped with an error",
  routine_message: "A bot has a message",
  meeting_done: "Your meeting notes are ready",
  meeting_failed: "Meeting notes failed",
  room_input: "A room is waiting on you",
  test: "This is a test notification",
}

// When the plugin is older or couldn't find a name.
const UNTITLED: Partial<Record<PushKind, string>> = {
  routine_failed: "A routine",
  routine_message: "A bot",
  clone_failed: "A project",
  research_brief: "A research mission",
  research_scope: "A research mission",
  research_done: "A research mission",
  research_failed: "A research mission",
  meeting_done: "A meeting",
  meeting_failed: "A meeting",
  room_input: "A room",
}

/** The notification's title and body: the notice's, and the kind's own line where it names none. */
export function pushText(kind: PushKind, detail: PushDetail = {}) {
  const title = detail.title?.trim() || UNTITLED[kind] || "Gots"
  const body = detail.body?.trim() || WORDS[kind]
  return { title, body }
}

/**
 * An http(s) address, and nothing else: what it is handed comes from a plugin, and a phone will
 * open whatever it is told to — a notice's picture, or a button's link (`actionsOf`).
 */
export function pictureOf(value: unknown) {
  const one = typeof value === "string" ? value.trim() : ""
  return /^https?:\/\/[^\s]+$/.test(one) ? one.slice(0, 512) : undefined
}

/** A bot id as the plugin keeps them (`BOT_ID` in `plugin/push.py`), which also names a drawable. */
export function botId(value: unknown) {
  const one = typeof value === "string" ? value.trim() : ""
  return /^[a-z0-9-]{1,32}$/.test(one) ? one : undefined
}

/** A moment as the plugin sends one: a whole, positive number of milliseconds, or nothing. */
export function momentOf(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * A chat's id as the plugin keeps them (`MAX_ID_LENGTH` in `plugin/chats.py`, and the characters a
 * chat's address carries), which a phone names a shortcut and its read mark by.
 */
export function chatId(value: unknown) {
  const one = typeof value === "string" ? value.trim() : ""
  return /^[A-Za-z0-9._-]{1,256}$/.test(one) ? one : undefined
}

/**
 * The buttons a tray may draw: at most two, each a label and an http(s) link, in the order the
 * notice carries them. Anything else is dropped rather than trusted — the plugin writes these, and
 * a phone's receiver posts whatever it is given.
 */
export function actionsOf(value: unknown): PushAction[] {
  if (!Array.isArray(value)) return []
  const kept: PushAction[] = []
  for (const one of value) {
    if (kept.length === 2) break
    if (!one || typeof one !== "object") continue
    const { label, url } = one as Partial<PushAction>
    if (typeof label !== "string" || !label.trim()) continue
    const link = pictureOf(url)
    if (!link) continue
    kept.push({ label: label.trim().slice(0, 40), url: link })
  }
  return kept
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
const TOKEN_URL = "https://oauth2.googleapis.com/token"

function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null
  try {
    // The key is stored as its JSON or as base64 of it, like the same secret in CI.
    const text = raw.trim().startsWith("{") ? raw : atob(raw.replace(/\s+/g, ""))
    const value = JSON.parse(text) as Partial<ServiceAccount>
    return typeof value.project_id === "string" &&
      typeof value.client_email === "string" &&
      typeof value.private_key === "string"
      ? (value as ServiceAccount)
      : null
  } catch {
    return null
  }
}

function base64Url(bytes: ArrayBuffer | Uint8Array | string) {
  const array =
    typeof bytes === "string"
      ? new TextEncoder().encode(bytes)
      : bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

async function signingKey(pem: string) {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
}

/** The OAuth token Google wants on a send. It lasts an hour, so a warm function reuses it. */
async function accessToken(account: ServiceAccount, cache: { token?: string; expires: number }) {
  const now = Math.floor(Date.now() / 1000)
  if (cache.token && cache.expires - 60 > now) return cache.token
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  )
  const signing = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${claims}`
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await signingKey(account.private_key),
    new TextEncoder().encode(signing),
  )
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signing}.${base64Url(signature)}`,
    }),
  })
  if (!response.ok) throw new Error(`Google answered ${response.status}`)
  const answer = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!answer.access_token) throw new Error("No access token")
  cache.token = answer.access_token
  cache.expires = now + (answer.expires_in ?? 3600)
  return cache.token
}

/**
 * The message Firebase sends: data-only, and every value a string.
 *
 * A `notification` payload is drawn by Android itself, while the app is closed and with no code of
 * ours running — and Android's own drawing has no room for a button. So the message carries the
 * notice instead and the app draws it (`GotsMessagingService`): the title and body, the bot's
 * picture, the chat it is about, the link its Reply posts to and whether it offers Mark as read,
 * the category's channel, the tag a newer notice of the same thing replaces, and the two links an
 * approval carries as JSON, since a data value can be nothing but a string.
 */
export function message(
  token: string,
  kind: PushKind,
  category: string,
  sessionId: string,
  detail: PushDetail = {},
) {
  const { title, body } = pushText(kind, detail)
  const actions = actionsOf(detail.actions)
  const face = botId(detail.bot)
  const icon = pictureOf(detail.icon)
  const chat = chatId(detail.chat)
  const reply = pictureOf(detail.reply)
  const at = momentOf(detail.at)
  return {
    message: {
      token,
      data: {
        kind,
        session_id: sessionId,
        title,
        body,
        category,
        // A newer message of the same category about the same thing replaces one still showing.
        tag: `${category}:${sessionId}`.slice(0, 200),
        // The channel Android's settings turn off one by one. The app makes one for each category
        // (`src/lib/push.ts`); the test has its own, made on the tap that sends one.
        channel: kind === "test" ? "test_notification" : category,
        ...(face ? { bot: face } : {}),
        ...(icon ? { icon } : {}),
        ...(actions.length ? { actions: JSON.stringify(actions) } : {}),
        ...(chat ? { chat } : {}),
        ...(reply ? { reply } : {}),
        ...(detail.read === true ? { read: "true" } : {}),
        ...(at ? { at: String(at) } : {}),
      },
      android: { priority: "HIGH", ttl: "600s" },
    },
  }
}

/** The sender for the configured service account, or null when none is set. */
export function createFcm(raw: string | undefined): FcmSender | null {
  const account = parseServiceAccount(raw)
  if (!account) return null
  const cache = { token: undefined as string | undefined, expires: 0 }

  async function deliver(
    token: string,
    kind: PushKind,
    category: string,
    sessionId: string,
    about?: PushDetail,
  ): Promise<{ result: SendResult; reason?: string }> {
    try {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account!.project_id)}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await accessToken(account!, cache)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(message(token, kind, category, sessionId, about)),
        },
      )
      if (response.ok) return { result: "ok" }
      const detail = (await response.json().catch(() => null)) as {
        error?: { status?: string; message?: string; details?: { errorCode?: string }[] }
      } | null
      // The app was uninstalled or the token rotated: only then is the token dropped.
      const unregistered =
        detail?.error?.status === "NOT_FOUND" ||
        detail?.error?.details?.some((d) => d.errorCode === "UNREGISTERED")
      const reason = detail?.error?.message ?? `Firebase answered ${response.status}`
      if (!unregistered) {
        // Google's own wording names the missing permission, the disabled API or the mismatched sender.
        const codes = detail?.error?.details?.map((d) => d.errorCode).filter(Boolean)
        console.error(
          "FCM refused a push",
          response.status,
          detail?.error?.status,
          codes?.join(","),
          detail?.error?.message,
        )
      }
      return { result: unregistered ? "gone" : "error", reason }
    } catch (error) {
      console.error("FCM push failed", error instanceof Error ? error.message : error)
      return { result: "error", reason: error instanceof Error ? error.message : "Push failed" }
    }
  }

  return {
    async send(token, kind, category, sessionId, detail) {
      return (await deliver(token, kind, category, sessionId, detail)).result
    },
    async test(token) {
      const { result, reason } = await deliver(token, "test", "test", "")
      return result === "ok" ? null : (reason ?? "Push failed")
    },
  }
}
