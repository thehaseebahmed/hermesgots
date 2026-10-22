import { App } from "@capacitor/app"
import { Browser } from "@capacitor/browser"
import { CapacitorHttp } from "@capacitor/core"
import type { User } from "@netlify/identity"

import type { Account } from "@/lib/account"
import { storedUser, tradeOutcome, type Tokens } from "@/lib/identity-session"
import { SITE_URL } from "@/lib/native"

/**
 * Identity for the Android app. `@netlify/identity` only talks to the page's own origin, which is
 * `https://localhost` here, so this calls the deploy's Identity API directly. Requests go through
 * native HTTP so CORS doesn't apply. GitHub sign-in runs in a Custom Tab on
 * `public/auth/native.html`, which hands the tokens back through `gots://auth`.
 *
 * Identity revokes a refresh token as it spends it, and more than one call site can reach a refresh
 * in the same tick, so this trades one at a time and re-reads the store before believing a
 * rejection: only the service's own word about the stored token ends the session (docs/adr/0001).
 */

const IDENTITY = `${SITE_URL}/.netlify/identity`
const STORAGE_KEY = "memento-identity"

const listeners = new Set<(account: Account) => void>()
let listening = false

function readTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Tokens) : null
  } catch {
    return null
  }
}

function writeTokens(tokens: Tokens | null) {
  if (tokens) localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens))
  else localStorage.removeItem(STORAGE_KEY)
}

function parse(data: unknown) {
  if (typeof data !== "string") return data
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

async function http(
  method: string,
  url: string,
  options: { token?: string; json?: unknown; form?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {}
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  if (options.json !== undefined) headers["Content-Type"] = "application/json"
  if (options.form) headers["Content-Type"] = "application/x-www-form-urlencoded"
  const response = await CapacitorHttp.request({
    method,
    url,
    headers,
    data: options.form ?? options.json,
  })
  return { status: response.status, data: parse(response.data) }
}

function toUser(data: Record<string, unknown>): User {
  const meta = (data.user_metadata ?? {}) as Record<string, unknown>
  const name = meta.full_name ?? meta.name
  return {
    id: String(data.id),
    email: typeof data.email === "string" ? data.email : undefined,
    name: typeof name === "string" ? name : undefined,
    pictureUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : undefined,
    userMetadata: meta,
    appMetadata: (data.app_metadata ?? {}) as Record<string, unknown>,
  }
}

function tokensFrom(params: URLSearchParams | Record<string, unknown>): Tokens | null {
  const get = (key: string) =>
    params instanceof URLSearchParams ? params.get(key) : (params[key] as string | undefined)
  const access = get("access_token")
  const refresh = get("refresh_token")
  if (!access || !refresh) return null
  const expiresIn = Number(get("expires_in"))
  return {
    access,
    refresh,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
  }
}

/** A trade already in flight. Identity revokes a refresh token as it spends it, so a second caller
 *  replaying the same one would be answered with a rejected token and read that as a sign-out. */
let inFlight: Promise<Tokens | null> | undefined

/** A token's first characters: enough to tell two trades apart in the console, no use to anyone. */
function tag(token: string | null | undefined) {
  return token ? token.slice(0, 6) : null
}

async function exchange(tokens: Tokens): Promise<Tokens | null> {
  const response = await http("POST", `${IDENTITY}/token`, {
    form: { grant_type: "refresh_token", refresh_token: tokens.refresh },
  })
  const stored = readTokens()
  const outcome = tradeOutcome(response.status, tokens.refresh, stored?.refresh ?? null)
  console.debug("[memento] identity refresh", {
    outcome,
    status: response.status,
    spent: tag(tokens.refresh),
    stored: tag(stored?.refresh),
  })
  if (outcome === "renewed") {
    const next = tokensFrom(response.data as Record<string, unknown>)
    if (!next) throw new Error("Sign-in refresh gave no tokens")
    writeTokens(next)
    return next
  }
  if (outcome === "swapped") return stored
  if (outcome === "retry") throw new Error(`Sign-in refresh failed (${response.status})`)
  writeTokens(null)
  notify({ status: "signed-out" })
  return null
}

function refresh(tokens: Tokens) {
  inFlight ??= exchange(tokens).finally(() => {
    inFlight = undefined
  })
  return inFlight
}

/** A current access token, refreshed when it is about to expire (or `force`d after a 401). */
export async function accessToken(force = false) {
  const tokens = readTokens()
  if (!tokens) return null
  if (!force && tokens.expiresAt - Date.now() > 60_000) return tokens.access
  return (await refresh(tokens))?.access ?? null
}

async function currentUser() {
  let token = await accessToken()
  if (!token) return null
  let response = await http("GET", `${IDENTITY}/user`, { token })
  if (response.status === 401) {
    token = await accessToken(true)
    if (!token) return null
    response = await http("GET", `${IDENTITY}/user`, { token })
  }
  if (response.status === 401) {
    writeTokens(null)
    return null
  }
  if (response.status !== 200) throw new Error(`Couldn't load the account (${response.status})`)
  return toUser(response.data as Record<string, unknown>)
}

/** The account's user: Identity's own answer when it can be asked, and the stored token's owner when
 *  it can't, so a check that fails leaves the session standing on what the store still holds
 *  (docs/adr/0001). */
async function identityUser(): Promise<User | null> {
  try {
    return await currentUser()
  } catch (error) {
    console.debug("[memento] identity unverified", error)
    return storedUser(readTokens()?.access ?? null)
  }
}

function notify(account: Account) {
  listeners.forEach((listener) => listener(account))
}

async function onAppUrl(url: string) {
  if (!url.startsWith("gots://auth")) return
  const tokens = tokensFrom(new URLSearchParams(url.split("#")[1] ?? ""))
  void Browser.close().catch(() => {})
  if (!tokens) return
  writeTokens(tokens)
  const user = await identityUser()
  notify(user ? { status: "signed-in", user } : { status: "signed-out" })
}

function listen() {
  if (listening) return
  listening = true
  void App.addListener("appUrlOpen", ({ url }) => void onAppUrl(url))
}

export async function loadNativeAccount(): Promise<Account> {
  if (!SITE_URL) return { status: "unavailable" }
  listen()
  try {
    const settings = await http("GET", `${IDENTITY}/settings`)
    const external = (settings.data as { external?: Record<string, boolean> } | null)?.external
    if (settings.status !== 200 || !external?.github) return { status: "unavailable" }
  } catch {
    return { status: "unavailable" }
  }
  const user = await identityUser()
  return user ? { status: "signed-in", user } : { status: "signed-out" }
}

export function watchNativeAccount(callback: (account: Account) => void) {
  listen()
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

export function nativeSignIn() {
  void Browser.open({ url: `${SITE_URL}/auth/native.html` })
}

export async function nativeSignOut() {
  const tokens = readTokens()
  writeTokens(null)
  notify({ status: "signed-out" })
  if (tokens) await http("POST", `${IDENTITY}/logout`, { token: tokens.access }).catch(() => {})
}

/** Calls the sync function with a Bearer token, shaped as a `Response` for `account.ts`. */
export async function nativeSyncCall(method: string, url: string, body?: unknown) {
  const send = async (token: string | null) => {
    const response = await http(method, url, { token: token ?? undefined, json: body })
    const empty = response.status === 204 || response.data === "" || response.data == null
    return new Response(empty ? null : JSON.stringify(response.data), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  let response = await send(await accessToken())
  if (response.status === 401) {
    const token = await accessToken(true)
    if (token) response = await send(token)
  }
  return response
}
