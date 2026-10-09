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
  "theseus",
  "run_done",
  "run_failed",
  "pr_checks",
  "pr_merged",
  "clone_failed",
  "routine_failed",
] as const
export type PushKind = (typeof PUSH_KINDS)[number] | "test"
export type SendResult = "ok" | "gone" | "error"

export const PUSH_CATEGORIES = [
  "chat_input",
  "chat_run_failed",
  "chat_run_done",
  "code_input",
  "code_theseus",
  "code_run_failed",
  "code_run_done",
  "code_pr_checks",
  "code_pr_merged",
  "code_setup_failed",
  "routine_failed",
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
  return `code_${kind}`
}

/** What the plugin tells about a push beyond its kind (0.33): the chat's title, a Theseus run's
 * stage and the bot character to show. */
export interface PushDetail {
  title?: string
  stage?: string
  bot?: string
}

export interface FcmSender {
  send(
    token: string,
    kind: PushKind,
    category: string,
    sessionId: string,
    detail?: PushDetail,
    site?: string,
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
  theseus: "Waiting for you",
  run_done: "You have a new reply",
  run_failed: "The run stopped with an error",
  pr_checks: "Checks are failing on the pull request",
  pr_merged: "Your pull request was merged",
  clone_failed: "This project couldn't be set up",
  routine_failed: "The last run failed",
  test: "This is a test notification",
}

const THESEUS_WORDS: Record<string, string> = {
  plan: "The plan is ready for your review",
  checkpoints: "The checkpoints are ready for your review",
  approval: "A checkpoint is waiting for your approval",
  closing: "All checkpoints are done, choose how to wrap up",
}

// When the plugin is older or couldn't find a name.
const UNTITLED: Partial<Record<PushKind, string>> = {
  routine_failed: "A routine",
  clone_failed: "A project",
}

const BOT = /^[a-z0-9-]{1,32}$/

/** The notification's title and body. */
export function pushText(kind: PushKind, detail: PushDetail = {}) {
  const title = detail.title?.trim() || UNTITLED[kind] || "Memento"
  const body = (kind === "theseus" && detail.stage && THESEUS_WORDS[detail.stage]) || WORDS[kind]
  return { title, body }
}

/** The bot's picture on the site, which Android shows beside the text. */
export function botImage(site: string | undefined, bot: string | undefined) {
  return site && bot && BOT.test(bot) ? `${site}/bots/${bot}.png` : undefined
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

export function message(
  token: string,
  kind: PushKind,
  category: string,
  sessionId: string,
  detail: PushDetail = {},
  site?: string,
) {
  const image = botImage(site, detail.bot)
  return {
    message: {
      token,
      // A notification message: Android shows it itself while the app is closed, with no code of
      // ours running. The data rides along for the tap. An image is shown as the large icon (and
      // enlarged when the notification is expanded): Firebase has no field for the large icon alone.
      notification: { ...pushText(kind, detail), ...(image ? { image } : {}) },
      data: { kind, session_id: sessionId },
      android: {
        priority: "HIGH",
        ttl: "600s",
        // A newer message of the same category about the same thing replaces one still showing. The
        // app makes a channel for each category (`src/lib/push.ts`), which Android's settings turn
        // off one by one; the test has the one the app has always had.
        notification: {
          tag: `${category}:${sessionId}`.slice(0, 200),
          channel_id: kind === "test" ? "sessions" : category,
        },
      },
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
    site?: string,
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
          body: JSON.stringify(message(token, kind, category, sessionId, about, site)),
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
    async send(token, kind, category, sessionId, detail, site) {
      return (await deliver(token, kind, category, sessionId, detail, site)).result
    },
    async test(token) {
      const { result, reason } = await deliver(token, "test", "test", "")
      return result === "ok" ? null : (reason ?? "Push failed")
    },
  }
}
