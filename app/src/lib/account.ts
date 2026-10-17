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

import { storedUser } from "@/lib/identity-session"
import { isNative, SITE_URL } from "@/lib/native"
import {
  loadNativeAccount,
  nativeSignIn,
  nativeSignOut,
  nativeSyncCall,
  watchNativeAccount,
} from "@/lib/native-account"

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

const FUNCTIONS = `${isNative ? SITE_URL : ""}/.netlify/functions`
const ENDPOINT = `${FUNCTIONS}/sync`

export class SyncError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "SyncError"
    this.status = status
  }
}

export async function loadAccount(): Promise<Account> {
  if (isNative) return loadNativeAccount()
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
  return browserAccount()
}

/** The access token `@netlify/identity` keeps for the page, in a cookie it makes readable to it: what
 *  this client has to prove a session with when the identity service can't be asked. */
function storedToken() {
  const match = /(?:^|;\s*)nf_jwt=([^;]*)/.exec(document.cookie)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    // A cookie something else mangled is no token, not a reason to fail the load.
    return null
  }
}

/**
 * The account: Identity's own answer, or what the stored token still proves. The store is what a
 * failed check falls back to, so a token still in it leaves the session standing instead of showing
 * the gate (docs/adr/0001). An empty store is no account: `@netlify/identity` deletes this cookie
 * itself when it reads a token as unusable, and a cookie that expired or was cleared leaves nothing
 * to stand on either — either way the credentials are gone and the sign-in is real.
 */
async function browserAccount(): Promise<Account> {
  try {
    const user = await getUser()
    if (user) return { status: "signed-in", user }
  } catch (error) {
    // Identity couldn't be asked. The stored token still names its owner, so the app runs.
    console.debug("[memento] identity unverified", error)
  }
  const user = storedUser(storedToken())
  return user ? { status: "signed-in", user } : { status: "signed-out" }
}

export function watchAccount(callback: (account: Account) => void) {
  if (isNative) return watchNativeAccount(callback)
  return onAuthChange((_event, user) =>
    callback(user ? { status: "signed-in", user } : { status: "signed-out" }),
  )
}

export function signIn() {
  if (isNative) return nativeSignIn()
  oauthLogin("github")
}

export async function signOut() {
  if (isNative) return nativeSignOut()
  await logout()
}

/** A signed-in call to one of the site's functions. */
export async function callFunction(method: string, url: string, body?: unknown) {
  if (isNative) return nativeSyncCall(method, url, body)
  const send = () =>
    fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  let response = await send()
  if (response.status === 401 && (await refreshSession())) response = await send()
  return response
}

function call(method: string, doc: string, body?: unknown) {
  return callFunction(method, `${ENDPOINT}?doc=${encodeURIComponent(doc)}`, body)
}

export function functionUrl(name: string, query: Record<string, string>) {
  return `${FUNCTIONS}/${name}?${new URLSearchParams(query)}`
}

export async function failure(response: Response) {
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
