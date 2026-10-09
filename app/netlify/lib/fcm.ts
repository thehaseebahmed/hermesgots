/**
 * Firebase Cloud Messaging from a Netlify function. The Android app can't use Web Push, and sending
 * through FCM takes a service account key, which can't live on every user's Hermes host. So a plugin
 * asks the registry to send (`push` in `registry.ts`) and the key stays here, in `FIREBASE_SERVICE_ACCOUNT` (the same key CI uses to reach App Distribution).
 * The message says that a session waits, never what it asked.
 */

export type PushKind = "approval" | "question" | "plan"
export type SendResult = "ok" | "gone" | "error"

export interface FcmSender {
  send(token: string, kind: PushKind, sessionId: string): Promise<SendResult>
}

interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

const WORDS: Record<PushKind, string> = {
  approval: "Needs your approval",
  question: "Has a question for you",
  plan: "Plan ready for review",
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

export function message(token: string, kind: PushKind, sessionId: string) {
  return {
    message: {
      token,
      // A notification message: Android shows it itself while the app is closed, with no code of
      // ours running. The data rides along for the tap.
      notification: { title: "Memento", body: WORDS[kind] },
      data: { kind, session_id: sessionId },
      android: {
        priority: "HIGH",
        ttl: "600s",
        // A newer message about the same session replaces one still showing.
        notification: { tag: `session:${sessionId}`.slice(0, 200), channel_id: "sessions" },
      },
    },
  }
}

/** The sender for the configured service account, or null when none is set. */
export function createFcm(raw: string | undefined): FcmSender | null {
  const account = parseServiceAccount(raw)
  if (!account) return null
  const cache = { token: undefined as string | undefined, expires: 0 }
  return {
    async send(token, kind, sessionId) {
      try {
        const response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${await accessToken(account, cache)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(message(token, kind, sessionId)),
          },
        )
        if (response.ok) return "ok"
        const detail = (await response.json().catch(() => null)) as {
          error?: { status?: string; message?: string; details?: { errorCode?: string }[] }
        } | null
        // The app was uninstalled or the token rotated: only then is the token dropped.
        const unregistered =
          detail?.error?.status === "NOT_FOUND" ||
          detail?.error?.details?.some((d) => d.errorCode === "UNREGISTERED")
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
        return unregistered ? "gone" : "error"
      } catch (error) {
        console.error("FCM push failed", error instanceof Error ? error.message : error)
        return "error"
      }
    },
  }
}
