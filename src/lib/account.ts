import {
  getSettings,
  getUser,
  handleAuthCallback,
  logout,
  oauthLogin,
  onAuthChange,
  refreshSession,
  type User,
} from "@netlify/identity"

/**
 * GitHub sign-in through Netlify Identity, and the sync function's document API. Signing in only
 * proves who owns the documents; it never unlocks them (see `vault.ts`).
 */

export type Account =
  | { status: "loading" }
  /** No Identity with GitHub on this deploy (plain `pnpm dev`, or it isn't set up). */
  | { status: "unavailable" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: User }

const ENDPOINT = "/.netlify/functions/sync"

export class SyncError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "SyncError"
    this.status = status
  }
}

export async function loadAccount(): Promise<Account> {
  try {
    const settings = await getSettings()
    if (!settings.providers.github) return { status: "unavailable" }
  } catch {
    return { status: "unavailable" }
  }
  try {
    // Finishes a GitHub redirect when the URL carries its token; a no-op otherwise.
    await handleAuthCallback()
  } catch {
    // An expired or reused callback leaves the user signed out; the card offers sign-in again.
  }
  const user = await getUser().catch(() => null)
  return user ? { status: "signed-in", user } : { status: "signed-out" }
}

export function watchAccount(callback: (account: Account) => void) {
  return onAuthChange((_event, user) =>
    callback(user ? { status: "signed-in", user } : { status: "signed-out" }),
  )
}

export function signIn() {
  oauthLogin("github")
}

export async function signOut() {
  await logout()
}

async function call(method: string, doc: string, body?: unknown) {
  const send = () =>
    fetch(`${ENDPOINT}?doc=${encodeURIComponent(doc)}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  let response = await send()
  if (response.status === 401 && (await refreshSession())) response = await send()
  return response
}

async function failure(response: Response) {
  const body = await response.json().catch(() => null)
  return new SyncError(body?.error ?? `Sync failed (${response.status})`, response.status)
}

export async function getDoc<T>(doc: string): Promise<{ etag?: string; data: T } | null> {
  const response = await call("GET", doc)
  if (response.status === 404) return null
  if (!response.ok) throw await failure(response)
  return response.json()
}

/** Writes over the version read (`etag`), or creates it. False when someone else wrote first. */
export async function putDoc(doc: string, data: unknown, etag?: string) {
  const response = await call("PUT", doc, { data, etag })
  if (response.status === 412) return false
  if (!response.ok) throw await failure(response)
  return true
}

export async function deleteDoc(doc: string) {
  const response = await call("DELETE", doc)
  if (!response.ok) throw await failure(response)
}
